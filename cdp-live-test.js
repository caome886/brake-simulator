// 针对「已发布上线」的网址做端到端验收：真的能打开、能玩、能踩断踏板、能重试
// 用法: node cdp-live-test.js [url]
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const URL = process.argv[2] || 'https://caome886.github.io/brake-simulator/';
const profile = path.join(os.tmpdir(), 'brake-live-' + Date.now());

function get(p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(b));
    });
    req.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) { try { ver = JSON.parse(await get('/json/version')); break; } catch { await sleep(250); } }
  if (!ver) { console.log('CDP 连接失败'); chrome.kill(); process.exit(1); }

  const page = JSON.parse(await get('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = []; const responses = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Runtime.exceptionThrown') errors.push('异常: ' + (m.params.exceptionDetails.text || ''));
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.url.includes('github.io') || r.url.includes('jsdelivr')) {
        responses.push(r.status + ' ' + r.mimeType + ' ' + r.url.slice(0, 90));
      }
    }
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');

  console.log('=== 打开 ' + URL + ' ===');
  await send('Page.navigate', { url: URL });
  await sleep(5000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result && r.result.result.value;
  };
  const state = () => evalJs('window.__brake && window.__brake.state()');
  const step = n => evalJs('window.__brake.step(' + n + ')');
  const keys = o => evalJs('window.__brake.keys(' + JSON.stringify(o) + ')');

  console.log('网络响应:', JSON.stringify(responses, null, 1));
  const meta = await evalJs(`JSON.stringify({
    url: location.href, title: document.title,
    hasBrakeApi: !!window.__brake,
    canvasW: (document.getElementById('cv')||{}).width,
    canvasH: (document.getElementById('cv')||{}).height,
    isTouchUI: document.body.classList.contains('touch')
  })`);
  console.log('页面信息:', meta);

  if (!(await evalJs('!!window.__brake'))) {
    console.log('✗ 线上页面的游戏没有加载起来');
    console.log('页面文本:', await evalJs('document.body.innerText.slice(0,300)'));
    chrome.kill(); process.exit(1);
  }

  console.log('=== 1. 加速 3 秒 ===');
  await keys({ Space: true });
  await step(360);
  console.log(JSON.stringify(await state()));

  console.log('=== 2. 按住刹车直到 1600N 断裂 ===');
  await keys({ Space: false, ArrowDown: true });
  await step(200);
  const s1 = await state();
  console.log(JSON.stringify(s1));
  console.log('  踏板断裂 =', s1.broken, '｜ 碎片数 =', s1.frags);

  console.log('=== 3. 进入失败界面 ===');
  await step(300);
  const s2 = await state();
  console.log('  phase =', s2.phase, '｜ failT =', +s2.failT.toFixed(2));

  console.log('=== 4. 点击「重试」按钮 ===');
  const rect = await evalJs('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()');
  const bx = rect.x + rect.w * (480 / 960), by = rect.y + rect.h * (423 / 560);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: bx, y: by, button: 'left', clickCount: 1 });
  }
  await sleep(400);
  const s3 = await state();
  console.log('  重试后 phase =', s3.phase, '｜ RESETS =', s3.RESETS);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(__dirname, 'shots', '70-live-githubpages.png');
  fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('截图: ' + out);

  const ok = s1.broken && s1.frags === 4 && s2.phase === 'failed' && s3.RESETS === 1 && errors.length === 0;
  console.log('页面错误:', errors.length ? errors : '无');
  console.log(ok ? '✓ 线上网址验收通过：能玩、能踩断、能重试' : '✗ 线上验收未通过');
  chrome.kill();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR: ' + (e && e.stack || e)); process.exit(1); });
