// 局域网聊天服务：静态页面 + WebSocket 实时推送 + 本地文件存储（无外部数据库/云服务）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

// 打包为 exe（Node SEA）时：静态页面来自内嵌资源，数据存到 %LOCALAPPDATA%\LocalChat\data
let IS_SEA = false;
try { IS_SEA = require('node:sea').isSea(); } catch {}
let EMBEDDED_PUBLIC = null;
try { EMBEDDED_PUBLIC = require('embedded-public'); } catch {}

const PORT = +(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = IS_SEA
  ? path.join(process.env.LOCALAPPDATA || path.dirname(process.execPath), 'LocalChat', 'data')
  : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STICKER_DIR = path.join(DATA_DIR, 'stickers');
const MSG_FILE = path.join(DATA_DIR, 'messages.jsonl');
const USER_FILE = path.join(DATA_DIR, 'users.json');

const MAX_IMG_BYTES = 10 * 1024 * 1024;    // 图片最大 10MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 视频最大 200MB
const MAX_STICKER_BYTES = 5 * 1024 * 1024; // 贴纸最大 5MB
const HISTORY_SEND = 500;   // 新用户进入时最多推送最近 500 条
const HISTORY_KEEP = 5000;  // 本地最多保留 5000 条，超出自动裁剪

const IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1 };
const VIDEO_EXT = { mp4: 1, webm: 1, mov: 1, m4v: 1 };

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(STICKER_DIR, { recursive: true });

// ---------- 本地存储 ----------
let users = {};
try { users = JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch { users = {}; }
const saveUsers = () => fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));

let history = [];
try {
  history = fs.readFileSync(MSG_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
} catch { history = []; }

function persistMessage(msg) {
  history.push(msg);
  fs.appendFileSync(MSG_FILE, JSON.stringify(msg) + '\n');
  if (history.length > HISTORY_KEEP) {
    history = history.slice(-HISTORY_KEEP);
    fs.writeFileSync(MSG_FILE, history.map(m => JSON.stringify(m)).join('\n') + '\n');
  }
}

// ---------- 工具 ----------
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function nicknameFor(ip) {
  return users[ip] || '用户-' + ip.split('.').pop();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};

// 流式保存上传体到文件，超限即中止并删除半成品
function streamToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0, failed = false;
    const fail = msg => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(file, () => {});
      req.destroy();
      reject(new Error(msg));
    };
    req.on('data', c => { size += c.length; if (size > limit) fail('文件超过大小限制'); });
    req.on('error', () => fail('上传中断'));
    out.on('error', () => fail('写入失败'));
    out.on('finish', () => resolve(size));
    req.pipe(out);
  });
}

function fileExt(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);

  try {
    // 当前访问者身份（IP + 昵称）
    if (url.pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { ip, nickname: users[ip] || null, defaultNickname: nicknameFor(ip) });
    }

    // 设置昵称
    if (url.pathname === '/api/nickname' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      const name = String(body.nickname || '').trim().slice(0, 20);
      if (!name) return sendJson(res, 400, { error: '昵称不能为空' });
      const old = nicknameFor(ip);
      users[ip] = name;
      saveUsers();
      if (old !== name) {
        const sys = makeMessage('system', ip, old, { text: `「${old}」改名为「${name}」` });
        persistMessage(sys);
        broadcast({ type: 'chat', message: sys });
      }
      broadcastUsers();
      return sendJson(res, 200, { ok: true, nickname: name });
    }

    // 清空聊天记录（消息 + 已上传的图片/视频；贴纸库保留）
    if (url.pathname === '/api/clear' && req.method === 'POST') {
      history = [];
      fs.writeFileSync(MSG_FILE, '');
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
      }
      broadcast({ type: 'clear' });
      const sys = makeMessage('system', ip, nicknameFor(ip), { text: `「${nicknameFor(ip)}」清空了聊天记录` });
      persistMessage(sys);
      broadcast({ type: 'chat', message: sys });
      return sendJson(res, 200, { ok: true });
    }

    // 文件上传：二进制流（图片/视频），兼容旧的 base64 JSON 图片上传
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      if ((req.headers['content-type'] || '').includes('application/json')) {
        const body = JSON.parse((await readBody(req, MAX_IMG_BYTES * 2)).toString() || '{}');
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(String(body.data || ''));
        if (!m) return sendJson(res, 400, { error: '仅支持 png/jpg/gif/webp 图片' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_IMG_BYTES) return sendJson(res, 400, { error: '图片不能超过 10MB' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
        return sendJson(res, 200, { ok: true, url: '/uploads/' + name, kind: 'image' });
      }
      const ext = fileExt(url.searchParams.get('name'));
      const isImg = !!IMG_EXT[ext], isVideo = !!VIDEO_EXT[ext];
      if (!isImg && !isVideo) return sendJson(res, 400, { error: '仅支持 png/jpg/gif/webp 图片或 mp4/webm/mov 视频' });
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      await streamToFile(req, path.join(UPLOAD_DIR, name), isVideo ? MAX_VIDEO_BYTES : MAX_IMG_BYTES);
      return sendJson(res, 200, { ok: true, url: '/uploads/' + name, kind: isVideo ? 'video' : 'image' });
    }

    // 贴纸列表 / 添加贴纸（所有用户共享，支持图片和视频）
    if (url.pathname === '/api/stickers' && req.method === 'GET') {
      const stickers = fs.readdirSync(STICKER_DIR)
        .filter(f => IMG_EXT[fileExt(f)] || VIDEO_EXT[fileExt(f)])
        .map(f => '/stickers/' + f);
      return sendJson(res, 200, { stickers });
    }
    if (url.pathname === '/api/stickers' && req.method === 'POST') {
      const ext = fileExt(url.searchParams.get('name'));
      if (!IMG_EXT[ext] && !VIDEO_EXT[ext]) return sendJson(res, 400, { error: '贴纸仅支持图片或视频' });
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      await streamToFile(req, path.join(STICKER_DIR, name), IMG_EXT[ext] ? MAX_STICKER_BYTES : MAX_VIDEO_BYTES);
      return sendJson(res, 200, { ok: true, url: '/stickers/' + name });
    }

    // 把聊天中已上传的图片/视频收藏为贴纸
    if (url.pathname === '/api/save-sticker' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      const u = String(body.url || '');
      if (!/^\/uploads\/[\w.-]+$/.test(u)) return sendJson(res, 400, { error: '无效的文件地址' });
      const srcName = path.basename(u);
      const ext = fileExt(srcName);
      if (!IMG_EXT[ext] && !VIDEO_EXT[ext]) return sendJson(res, 400, { error: '仅支持图片或视频' });
      const src = path.join(UPLOAD_DIR, srcName);
      if (!fs.existsSync(src)) return sendJson(res, 404, { error: '文件不存在（可能已被清理）' });
      const limit = IMG_EXT[ext] ? MAX_STICKER_BYTES : MAX_VIDEO_BYTES;
      if (fs.statSync(src).size > limit) return sendJson(res, 400, { error: '文件过大，无法收藏为贴纸' });
      const dest = path.join(STICKER_DIR, crypto.randomBytes(8).toString('hex') + '.' + ext);
      fs.copyFileSync(src, dest);
      return sendJson(res, 200, { ok: true, url: '/stickers/' + path.basename(dest) });
    }

    // 贴纸文件
    if (url.pathname.startsWith('/stickers/') && req.method === 'GET') {
      const name = path.basename(url.pathname);
      const file = path.join(STICKER_DIR, name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    // 上传的图片/视频
    if (url.pathname.startsWith('/uploads/') && req.method === 'GET') {
      const name = path.basename(url.pathname);
      const file = path.join(UPLOAD_DIR, name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    // 静态页面（打包为 exe 时用内嵌资源）
    if (req.method === 'GET') {
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      if (EMBEDDED_PUBLIC) {
        const embedded = EMBEDDED_PUBLIC[p];
        if (!embedded) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(Buffer.from(embedded, 'base64'));
        return;
      }
      const file = path.join(PUBLIC_DIR, path.normalize(p));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return sendJson(res, 404, { error: 'not found' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

function makeMessage(kind, ip, nickname, extra) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    kind,               // chat | image | video | sticker | system
    ip, nickname,
    time: Date.now(),
    ...extra,
  };
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(data);
  }
}

function onlineList() {
  const ips = new Map();
  for (const c of wss.clients) {
    if (c.readyState === 1 && c.clientIp) ips.set(c.clientIp, nicknameFor(c.clientIp));
  }
  return [...ips.entries()].map(([ip, nickname]) => ({ ip, nickname }));
}

// 解析消息里的 @：返回 { mentionAll, mentions:[ip...] }
function parseMentions(text, selfIp) {
  if (/@(所有人|all)(?![\w一-龥])/i.test(text)) return { mentionAll: true, mentions: [] };
  const nickToIp = new Map();
  for (const [uip, nick] of Object.entries(users)) nickToIp.set(nick, uip);
  for (const { ip: uip, nickname } of onlineList()) nickToIp.set(nickname, uip);
  const mentions = new Set();
  for (const [nick, uip] of [...nickToIp.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (nick && uip !== selfIp && text.includes('@' + nick)) mentions.add(uip);
  }
  return { mentionAll: false, mentions: [...mentions] };
}

function broadcastUsers() {
  broadcast({ type: 'users', users: onlineList() });
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.clientIp = ip;

  ws.send(JSON.stringify({
    type: 'init',
    me: { ip, nickname: nicknameFor(ip) },
    history: history.slice(-HISTORY_SEND),
    users: onlineList().concat([[ip, nicknameFor(ip)]].map(([i, n]) => ({ ip: i, nickname: n })))
      .filter((v, i, a) => a.findIndex(x => x.ip === v.ip) === i),
  }));

  const join = makeMessage('system', ip, nicknameFor(ip), { text: `「${nicknameFor(ip)}」进入了聊天室` });
  persistMessage(join);
  broadcast({ type: 'chat', message: join });
  broadcastUsers();

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const nickname = nicknameFor(ip);

    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 2000);
      if (!text) return;
      const { mentionAll, mentions } = parseMentions(text, ip);
      const msg = makeMessage('chat', ip, nickname, { text, mentions, mentionAll });
      persistMessage(msg);
      broadcast({ type: 'chat', message: msg });
    } else if (data.type === 'image' || data.type === 'video' || data.type === 'sticker') {
      const urlImg = String(data.url || '');
      const pattern = data.type === 'sticker' ? /^\/stickers\/[\w.-]+$/ : /^\/uploads\/[\w.-]+$/;
      if (!pattern.test(urlImg)) return;
      const msg = makeMessage(data.type, ip, nickname, { url: urlImg });
      persistMessage(msg);
      broadcast({ type: 'chat', message: msg });
    }
  });

  ws.on('close', () => {
    setTimeout(() => {
      // 同一 IP 可能有多个标签页，全部关闭才算离开
      const still = [...wss.clients].some(c => c.readyState === 1 && c.clientIp === ip);
      if (!still) {
        const leave = makeMessage('system', ip, nicknameFor(ip), { text: `「${nicknameFor(ip)}」离开了聊天室` });
        persistMessage(leave);
        broadcast({ type: 'chat', message: leave });
        broadcastUsers();
      }
    }, 500);
  });
});

// ---------- 局域网服务发现（UDP 应答） ----------
// 其他电脑上的启动器广播 LOCALCHAT_PING，这里应答 LOCALCHAT_PONG:<端口>
const DISCOVERY_PORT = 37441;
function startDiscoveryResponder() {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      if (msg.toString() === 'LOCALCHAT_PING') {
        sock.send(Buffer.from('LOCALCHAT_PONG:' + PORT), rinfo.port, rinfo.address, () => {});
      }
    });
    sock.on('error', () => {});
    sock.bind(DISCOVERY_PORT);
  } catch {}
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用，可能已有聊天服务在本机运行。`);
  } else {
    console.error('启动失败:', e.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, () => {
  startDiscoveryResponder();
  console.log('======================================');
  console.log('  局域网聊天室已启动！');
  console.log('  本机访问:   http://localhost:' + PORT);
  for (const ip of lanAddresses()) {
    console.log(`  局域网访问: http://${ip}:${PORT}   <== 把这个链接发给局域网内的同事/朋友`);
  }
  console.log('  数据保存在: ' + DATA_DIR);
  console.log('======================================');
});
