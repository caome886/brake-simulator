// 通过 CDP 在无头 Chrome 中逐步推进游戏模拟并断言状态
// 用法: node cdp-test.js
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const URL = 'http://127.0.0.1:8123/';
const profile = path.join(os.tmpdir(), 'brake-cdp-' + Date.now());

function get(pathname) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => res(b));
    });
    req.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('/json/version')); break; } catch { await sleep(250); }
  }
  if (!ver) { console.log('CDP 连接失败'); chrome.kill(); process.exit(1); }

  const targets = JSON.parse(await get('/json/list'));
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  const send = (method, params) => new Promise(res => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result && r.result.result.value;
  };
  const state = () => evalJs('window.__brake.state()');
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(__dirname, 'shots', name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const log = (label, s) => console.log(label.padEnd(20), JSON.stringify(s));
  const keys = (o) => evalJs('window.__brake.keys(' + JSON.stringify(o) + ')');
  const step = (n) => evalJs('window.__brake.step(' + n + ')');

  console.log('=== 1. 加速（仅按油门）===');
  await keys({ Space: true, ArrowDown: false });
  for (const sec of [1, 2, 3, 5]) {
    await step(120);
    const s = await state();
    log('加速 ' + sec + 's', { speed: +s.speed.toFixed(1), force: +s.force.toFixed(0) });
  }

  console.log('=== 2. 按住刹车 1s（应同时减速 + 受力增长）===');
  await keys({ Space: false, ArrowDown: true });
  await step(120);
  log('刹车 1s', await state());
  await shot('50-brake-hold');

  console.log('=== 3. 松开刹车 0.4s（受力应迅速归零、不再减速）===');
  await keys({ ArrowDown: false });
  await step(12); log('松开 0.1s', await state());
  await step(36); const rel = await state(); log('松开 0.4s', rel);
  await step(60); const rel2 = await state(); log('松开 0.9s', rel2);
  const drag = 1.1;   // TUNE.drag：滚阻/风阻（km/h per second）
  console.log('  → 松开刹车后受力:', rel.force.toFixed(1), 'N →', rel2.force.toFixed(1), 'N');
  console.log('  → 松开后 0.5s 车速变化:', (rel.speed - rel2.speed).toFixed(3), 'km/h（应仅约等于滚阻',
    ((rel.speed - rel2.speed) / 0.5).toFixed(2), 'km/h/s，刹车力已停止）');

  console.log('=== 4. 再次长按刹车到断裂 ===');
  await keys({ ArrowDown: true });
  await step(200); log('长按 1.67s', await state());
  await shot('51-break-moment');
  await step(30); log('断裂 +0.25s', await state());
  await shot('52-break-anim');
  await step(240); log('失败界面', await state());
  await shot('53-fail-screen');

  console.log('=== 5. 点击重试 ===');
  const rect = await evalJs('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()');
  const bx = rect.x + rect.w * (480 / 960), by = rect.y + rect.h * (423 / 560);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: bx, y: by, button: 'left', clickCount: 1 });
  }
  await sleep(300);
  log('重试后', await state());

  console.log('页面错误:', errors.length ? errors : '无');
  chrome.kill();
  process.exit(0);
})();
