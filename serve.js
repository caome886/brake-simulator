// 极简静态服务器：仅用于本地预览《刹车模拟器》
// 默认监听所有网卡，这样同一 WiFi 下的手机也能打开（用本机内网 IP + 端口）。
// 只想本机访问可以设置 HOST=127.0.0.1。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || '0.0.0.0';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, HOST, () => {
  console.log('刹车模拟器已启动：');
  console.log('  本机：  http://127.0.0.1:' + PORT + '/');
  for (const ip of lanIPs()) {
    console.log('  手机（同一 WiFi）：http://' + ip + ':' + PORT + '/');
  }
  if (HOST === '0.0.0.0') console.log('（若手机打不开，检查 Windows 防火墙是否放行了 ' + PORT + ' 端口）');
});
