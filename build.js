// 构建单文件 exe：esbuild 打包（含 ws 和内嵌页面） → Node SEA 注入
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. 内嵌静态页面
const pub = {};
for (const f of fs.readdirSync(path.join(__dirname, 'public'))) {
  pub['/' + f] = fs.readFileSync(path.join(__dirname, 'public', f)).toString('base64');
}
fs.writeFileSync(path.join(DIST, 'embedded-public.cjs'),
  'module.exports = ' + JSON.stringify(pub) + ';\n');
console.log('1/5 静态页面已内嵌（' + Object.keys(pub).length + ' 个文件）');

const run = cmd => { console.log('$ ' + cmd); execSync(cmd, { stdio: 'inherit', cwd: __dirname }); };

// 2. esbuild 打包（launcher 是入口，server.js / ws / 内嵌页面全部打进去）
run('npx esbuild launcher.js --bundle --platform=node --format=cjs --target=node18 ' +
  '--alias:embedded-public=./dist/embedded-public.cjs ' +
  '--external:bufferutil --external:utf-8-validate ' +
  '--outfile=dist/bundle.cjs');
console.log('2/5 JS 打包完成');

// 3. 生成 SEA blob
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
  main: path.join(DIST, 'bundle.cjs'),
  output: path.join(DIST, 'sea.blob'),
  disableExperimentalSEAWarning: true,
}));
run('node --experimental-sea-config dist/sea-config.json');
console.log('3/5 SEA blob 生成完成');

// 4. 复制 node.exe 作为载体
fs.copyFileSync(process.execPath, path.join(DIST, 'localchat.exe'));
console.log('4/5 已复制 Node 运行时');

// 5. 注入 blob
run('npx postject dist/localchat.exe NODE_SEA_BLOB dist/sea.blob ' +
  '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
console.log('5/5 注入完成: dist/localchat.exe');
