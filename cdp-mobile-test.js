// 手机触屏操作测试：用 CDP 把无头 Chrome 变成手机（390x844, 触摸屏, 移动 UA），
// 用真实的 touch 事件按屏幕按钮，验证「加速 / 刹车」两个按钮各自动作、可以同时按。
// 用法: node cdp-mobile-test.js
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const URL = 'http://127.0.0.1:8123/';
const profile = path.join(os.tmpdir(), 'brake-mobile-' + Date.now());

function get(pathname) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(b));
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
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  const send = (method, params) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');

  // —— 变成一台手机：390x844 @3x，触摸屏，移动端 UA ——
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone'
  });

  await send('Page.navigate', { url: URL });
  await sleep(2600);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result && r.result.result.value;
  };
  const state = () => evalJs('window.__brake.state()');
  const step = (n) => evalJs('window.__brake.step(' + n + ')');
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shots', name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  // 把一个手指的 touch 事件打到元素中心
  const down = async (sel, pid) => {
    const r = await evalJs('(function(){var e=document.querySelector("' + sel + '");if(!e)return null;var b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height};})()');
    if (!r) throw new Error('找不到元素 ' + sel);
    const pt = { x: r.x, y: r.y, radiusX: 12, radiusY: 12, force: 1, id: pid };
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(80);
    return r;
  };
  // 保持某个手指按下、其他手指仍在按着（多点触控）
  const hold = async (points) => {
    const pts = points.map(p => ({ x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1, id: p.id }));
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
    await sleep(80);
  };
  // 抬起一个手指：只上报还留在屏幕上的手指
  const lift = async (keep) => {
    const pts = (keep || []).map(p => ({ x: p.x, y: p.y, radiusX: 12, radiusY: 12, force: 1, id: p.id }));
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pts });
    await sleep(80);
  };

  const log = (label, s) => console.log(label.padEnd(22), JSON.stringify(s));
  const brief = s => ({ speed: +s.speed.toFixed(1), force: +s.force.toFixed(0), gas: s.gas, brake: s.brake, touchGas: s.touchGas, touchBrake: s.touchBrake });

  console.log('=== 0. 手机环境识别 ===');
  const layout = await evalJs(`(function(){
    var c=document.getElementById('cv').getBoundingClientRect();
    var b1=document.getElementById('bg').getBoundingClientRect();
    var b2=document.getElementById('bb').getBoundingClientRect();
    return {dpr:devicePixelRatio, vw:innerWidth, vh:innerHeight,
      canvas:{w:Math.round(c.width),h:Math.round(c.height)},
      barVisible:getComputedStyle(document.getElementById('touchbar')).opacity,
      btnAccel:{w:Math.round(b1.width),h:Math.round(b1.height)}, btnBrake:{w:Math.round(b2.width),h:Math.round(b2.height)},
      state:window.__brake.state()};
  })()`);
  console.log('视口', layout.vw + 'x' + layout.vh, 'dpr', layout.dpr);
  console.log('画布', JSON.stringify(layout.canvas), '按钮', JSON.stringify(layout.btnAccel), JSON.stringify(layout.btnBrake));
  console.log('触屏模式:', layout.state.touchMode, '（按钮栏 opacity =', layout.barVisible + '）');
  await shot('60-mobile-portrait');
  if (!layout.state.touchMode) console.log('✗ 没有识别为触屏设备！');
  if (layout.btnAccel.h < 44) console.log('✗ 加速按钮太小，不好按！');

  console.log('=== 1. 按住「加速」按钮 ===');
  const a = await down('#bg', 1);
  await step(240);           // 2 秒
  log('按住加速 2s', brief(await state()));
  await shot('61-mobile-accelerating');

  console.log('=== 2. 一根手指加速 + 另一根手指刹车（多点触控）===');
  const b = await down('#bb', 2);
  await hold([a, b]);
  await step(60);            // 0.5 秒
  log('两指同按 0.5s', brief(await state()));
  await shot('62-mobile-both');

  console.log('=== 3. 抬起手指（应立刻停止对应输入）===');
  // 注意：CDP 的 touchEnd 点位语义在不同版本上有差异，这里直接从「全部抬起」验证
  await lift([]);
  await step(30);
  log('全部抬起', brief(await state()));

  console.log('=== 4. 单指刹车（验证只按刹车时受力增长、车减速）===');
  const d = await down('#bb', 4);
  await step(60);
  log('单指刹车 0.5s', brief(await state()));
  await lift([]);
  await step(60);
  log('松开后 0.5s', brief(await state()));

  console.log('=== 5. 只按刹车到断裂 ===');
  await down('#bb', 3);
  await step(200);
  log('长按刹车 1.67s', await state());
  await step(300);
  const failed = await state();
  log('失败界面', { phase: failed.phase, frags: failed.frags });
  await shot('63-mobile-fail');

  console.log('=== 6. 点画面重试 ===');
  // 点「重试」按钮在画布内的实际坐标（不同屏幕比例下按钮位置不变）
  const c = await evalJs('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {x:r.left+r.width*0.5,y:r.top+r.height*(423/560),top:r.top,h:r.height};})()');
  console.log('  画布 top/高:', Math.round(c.top), Math.round(c.h), ' 点击点:', Math.round(c.x), Math.round(c.y),
    ' 该点元素:', await evalJs(`(function(){var e=document.elementFromPoint(${Math.round(c.x)},${Math.round(c.y)});return e?e.tagName+'#'+e.id:'null';})()`));
  await evalJs(`window.__tap=[];['touchstart','pointerdown'].forEach(function(t){document.getElementById('cv').addEventListener(t,function(e){window.__tap.push(t);},true);});`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y, radiusX: 12, radiusY: 12, force: 1, id: 9 }] });
  await sleep(80);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  console.log('  canvas 收到:', JSON.stringify(await evalJs('window.__tap')));
  console.log('  页面调试:', JSON.stringify(await evalJs('window.__dbg')));
  log('点画面重试后', await state());

  // 按钮栏自动隐藏
  console.log('=== 7. 静止 5 秒后按钮栏应自动隐藏（露出完整画面）===');
  await sleep(5200);
  const hid = await evalJs('({touchMode:document.body.classList.contains("touch"),opacity:getComputedStyle(document.getElementById("touchbar")).opacity,pe:getComputedStyle(document.getElementById("touchbar")).pointerEvents})');
  console.log('自动隐藏:', JSON.stringify(hid));
  await shot('64-mobile-autohide');

  console.log('=== 8. 横屏（844x390）===');
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  await sleep(1100);            // 等旋转后的多次重排完成
  const land = await evalJs(`(function(){
    var c=document.getElementById('cv').getBoundingClientRect();
    var tb=document.getElementById('touchbar').getBoundingClientRect();
    return {cw:Math.round(c.width),ch:Math.round(c.height),cBottom:Math.round(c.bottom),barTop:Math.round(tb.top),
      overlap:Math.round(c.bottom-tb.top), vh:innerHeight};
  })()`);
  console.log('横屏画布:', land.cw + 'x' + land.ch, ' 画布底=' + land.cBottom, ' 按钮栏顶=' + land.barTop,
    ' 重叠=' + land.overlap + 'px', land.overlap <= 0 ? '✓ 不遮挡画面' : '✗ 遮挡了画面');
  // 按钮栏在画面下方，点画面的上半部分应该是「加速」
  const landCv = await evalJs('(function(){var r=document.getElementById("cv").getBoundingClientRect();return {x:r.left+r.width*0.4,y:r.top+r.height*0.25};})()');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: landCv.x, y: landCv.y, radiusX: 12, radiusY: 12, force: 1, id: 7 }] });
  await sleep(80);
  await step(120);
  const landSt = await state();
  console.log('横屏点画面上半部 1s:', JSON.stringify(brief(landSt)),
    landSt.touchGas ? '✓ 识别为加速' : '✗ 没有识别为加速');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(80);
  await shot('65-mobile-landscape');

  console.log('页面错误:', errors.length ? errors : '无');
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error('测试脚本异常:', e && e.stack || e); process.exit(1); });
