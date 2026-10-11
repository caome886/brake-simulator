// 在 GitHub 网页上创建仓库（走网页自己的表单，复用浏览器登录态，无需 token）
// 用法: node gh-create-repo.js <仓库名> [描述]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9399;

function jget(p) {
  return new Promise((res, rej) => {
    const req = http.get('http://127.0.0.1:' + PORT + p, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const page = (await jget('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Page.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result && r.result.result.value;
  };
  const navigate = async (url, ms) => { await send('Page.navigate', { url }); await sleep(ms || 3500); return evaluate('location.href'); };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(__dirname, 'shots', name);
    fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
    return out;
  };
  return { send, evaluate, navigate, shot, ws };
}

// React 受控输入：直接改 value 不会触发 React 的 onChange，必须用原生 setter + 派发 input 事件
const FILL = (sel, value) => `(function(){
  var el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return '找不到元素 ' + ${JSON.stringify(sel)};
  var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`;

(async () => {
  const repo = process.argv[2] || 'brake-simulator';
  const desc = process.argv[3] || '刹车模拟器 —— 上帝视角 2D 开车小游戏，踩刹车踏板受力到 1600N 就断，然后「遥遥领先」。手机也能玩。';
  const c = await connect();

  console.log('→ 打开新建仓库页');
  await c.navigate('https://github.com/new', 4000);

  console.log('→ 填写仓库名: ' + repo);
  console.log('  输入框回读: ' + await c.evaluate(FILL('#repository-name-input', repo)));

  const descSel = 'input[name=Description]';
  console.log('→ 填写描述');
  console.log('  描述框回读: ' + String(await c.evaluate(FILL(descSel, desc))).slice(0, 40) + '…');

  console.log('→ 点击 Create repository');
  const clicked = await c.evaluate(`(function(){
    var btn = [].find.call(document.querySelectorAll('button[type=submit]'), function(b){ return /Create repository/i.test(b.textContent); });
    if (!btn) return '没找到提交按钮';
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return '已点击';
  })()`);
  console.log('  ' + clicked);

  // 等待跳转到新仓库页
  let url = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    url = await c.evaluate('location.href');
    if (new RegExp('/' + repo + '$').test(url) || url.includes('/' + repo + '?')) break;
    if (/\/new/.test(url) === false && url.includes('github.com/')) break;
  }
  console.log('→ 当前地址: ' + url);
  const state = await c.evaluate(`JSON.stringify({
    url: location.href, title: document.title,
    notFound: /404|Not Found/i.test(document.title),
    hasReadme: /README/i.test(document.body.innerText.slice(0, 3000)),
    bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)
  })`);
  console.log(state);
  console.log('截图: ' + await c.shot('gh-created.png'));
  c.ws.close();
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
