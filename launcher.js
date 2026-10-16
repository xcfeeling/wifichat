// 启动器（exe 入口）：先探测局域网是否已有聊天服务
//   有 → 直接打开浏览器加入
//   没有 → 在本机启动服务（同时应答后续探测），再打开聊天框
// 文件名含 "Setup"（如 LocalChat-Setup.exe）时进入安装模式：安装自身后退出
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec, spawn, execSync } = require('child_process');

const DISCOVERY_PORT = 37441;
const PORT = +(process.env.PORT || 3000);

let IS_SEA = false;
try { IS_SEA = require('node:sea').isSea(); } catch {}

// ---------- 安装模式 ----------
function selfInstall() {
  const src = process.execPath;
  const destDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'LocalChat');
  const destExe = path.join(destDir, 'localchat.exe');
  // “局域网聊天室” 用字符码表示，避免脚本编码问题
  const appNameChars = '0x5C40,0x57DF,0x804A,0x5929,0x5BA4';

  console.log('Installing to ' + destDir + ' ...');
  fs.mkdirSync(destDir, { recursive: true });

  // 卸载脚本
  fs.writeFileSync(path.join(destDir, 'uninstall.ps1'), [
    '$appName = -join [char[]](' + appNameChars + ')',
    'Get-Process localchat -ErrorAction SilentlyContinue | Stop-Process -Force',
    'Remove-Item "$env:LOCALAPPDATA\\LocalChat" -Recurse -Force -ErrorAction SilentlyContinue',
    'Remove-Item ([Environment]::GetFolderPath(\'Desktop\') + "\\$appName.lnk") -Force -ErrorAction SilentlyContinue',
    'Remove-Item "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\$appName.lnk" -Force -ErrorAction SilentlyContinue',
    'Start-Process netsh -Verb RunAs -Wait -ArgumentList \'advfirewall firewall delete rule name="LocalChat"\'',
  ].join('\r\n'));
  fs.writeFileSync(path.join(destDir, 'uninstall.bat'),
    '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"\r\n');

  // 复制自身（目标正在运行时跳过覆盖）
  if (path.resolve(src) !== path.resolve(destExe)) {
    try {
      fs.copyFileSync(src, destExe);
    } catch (e) {
      console.log('Program files already in use by a running instance, keeping existing copy.');
    }
  }

  // 快捷方式（桌面 + 开始菜单）
  const psShortcut = [
    '$appName = -join [char[]](' + appNameChars + ')',
    '$exe = ' + JSON.stringify(destExe),
    '$dir = ' + JSON.stringify(destDir),
    '$links = @()',
    '$links += [Environment]::GetFolderPath(\'Desktop\') + "\\$appName.lnk"',
    '$links += "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\$appName.lnk"',
    '$ws = New-Object -ComObject WScript.Shell',
    'foreach ($p in $links) { $s = $ws.CreateShortcut($p); $s.TargetPath = $exe; $s.WorkingDirectory = $dir; $s.Save() }',
  ].join('\r\n');
  const tmpPs1 = path.join(os.tmpdir(), 'localchat-shortcut.ps1');
  fs.writeFileSync(tmpPs1, psShortcut);
  try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + tmpPs1 + '"'); } catch {}
  try { fs.unlinkSync(tmpPs1); } catch {}

  // 防火墙放行（一次 UAC 授权）
  let hasRule = false;
  try { execSync('netsh advfirewall firewall show rule name="LocalChat"', { stdio: 'ignore' }); hasRule = true; } catch {}
  if (!hasRule) {
    const fwPs1 = path.join(os.tmpdir(), 'localchat-fw.ps1');
    fs.writeFileSync(fwPs1, 'netsh advfirewall firewall add rule name="LocalChat" dir=in action=allow program="'
      + destExe + '" enable=yes\r\n');
    try {
      execSync('powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList \'-NoProfile -ExecutionPolicy Bypass -File \\"'
        + fwPs1.replace(/\\/g, '\\\\') + '\\"\'"', { stdio: 'ignore' });
    } catch {}
    try { fs.unlinkSync(fwPs1); } catch {}
  }

  console.log('Done. Launching...');
  const child = spawn(destExe, [], { detached: true, stdio: 'ignore' });
  child.unref();
  process.exit(0);
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

function broadcastAddresses() {
  const out = ['255.255.255.255'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = i.address.split('.').map(Number);
      const mask = (i.netmask || '255.255.255.0').split('.').map(Number);
      out.push(ip.map((p, k) => (p | (~mask[k] & 255)) & 255).join('.'));
    }
  }
  return [...new Set(out)];
}

// UDP 广播探测，收集 LOCALCHAT_PONG 应答
function discover(timeoutMs) {
  return new Promise(resolve => {
    const found = [];
    let done = false;
    const finish = () => { if (!done) { done = true; try { sock.close(); } catch {} resolve(found); } };
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch { return resolve(found); }
    const timer = setTimeout(finish, timeoutMs);
    sock.on('message', (msg, rinfo) => {
      const m = /^LOCALCHAT_PONG:(\d+)$/.exec(msg.toString());
      if (m && !found.some(f => f.host === rinfo.address && f.port === +m[1])) {
        found.push({ host: rinfo.address, port: +m[1] });
      }
    });
    sock.on('error', finish);
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      const ping = Buffer.from('LOCALCHAT_PING');
      for (const addr of broadcastAddresses()) {
        try { sock.send(ping, DISCOVERY_PORT, addr, () => {}); } catch {}
      }
    });
    void timer;
  });
}

// 确认应答者确实是我们的聊天服务
async function verify(urlBase, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(urlBase + '/api/me', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return typeof j.ip === 'string';
  } catch { return false; }
}

function openBrowser(url) {
  exec(`cmd /c start "" "${url}"`, () => {});
}

(async () => {
  // 安装模式：LocalChat-Setup.exe
  if (IS_SEA && /setup/i.test(path.basename(process.execPath))) {
    selfInstall();
    return;
  }
  console.log('======================================');
  console.log('  局域网聊天室');
  console.log('  正在探测局域网内的聊天服务...');
  console.log('======================================');

  // 先看本机是否已有实例在跑（重复双击的情况）
  const myIps = lanAddresses();
  if (await verify(`http://127.0.0.1:${PORT}`, 800)) {
    const url = `http://${myIps[0] || '127.0.0.1'}:${PORT}`;
    console.log('本机已有聊天服务在运行，直接加入: ' + url);
    openBrowser(url);
    return;
  }

  const found = await discover(1500);
  for (const f of found) {
    const urlBase = `http://${f.host}:${f.port}`;
    if (await verify(urlBase, 1200)) {
      console.log('发现聊天服务: ' + urlBase);
      console.log('正在打开聊天框...');
      openBrowser(urlBase);
      return;
    }
  }

  console.log('没有发现现有服务，本机将作为聊天服务器启动。');
  require('./server.js');
  setTimeout(() => {
    openBrowser(`http://${myIps[0] || '127.0.0.1'}:${PORT}`);
  }, 800);
})();
