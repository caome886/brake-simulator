// 通过 CDP 驱动「部署专用」Chrome 实例（端口 9399）在网页上下文中调用 GitHub API。
// 不在 Node 里直接请求 api.github.com：那样属于跨站请求，不会带上 github.com 的登录 Cookie，
// 必须让请求从 github.com 页面自己发出（同源），这样才复用你浏览器里已有的登录态。
//
// 用法（每个子命令独立运行）：
//   node gh-web.js login            检查登录状态
//   node gh-web.js whoami           取当前登录用户名
//   node gh-web.js shot <out.png>   截图，便于确认页面状态
//   node gh-web.js api <method> <path> [jsonBody]   以网页登录态调用 REST API
//   node gh-web.js raw <jsFile>     在页面上下文执行任意 JS（同源，可 fetch）
'use strict';
const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9399;
const BASE = 'http://127.0.0.1:' + PORT;

function jget(p) {
  return new Promise((res, rej) => {
    const req = require('http').get(BASE + p, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('非 JSON: ' + b.slice(0, 200))); } });
    });
    req.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const list = await jget('/json/list');
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用的标签页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else events.push(m);
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result && r.result.result && r.result.result.value;
  };
  const navigate = async (url, waitMs) => {
    await send('Page.navigate', { url });
    await sleep(waitMs || 2500);
    return evaluate('location.href');
  };
  const shot = async (out) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
    return out;
  };
  return { ws, send, evaluate, navigate, shot, events, page };
}

// 在 github.com 页面上下文里以网页登录态调用 REST API。
// 注意：不能用 window.fetch —— github.com 页面自己包装/拦截了 fetch（会报 Failed to fetch），
// 用页面原生 XMLHttpRequest 才走得通。
function apiExpr(method, apiPath, body) {
  const payload = JSON.stringify({ method: method, path: apiPath, body: body || null });
  return `(async () => {
    const req = ${payload};
    return await new Promise((resolve) => {
      const meta = document.querySelector('meta[name=csrf-token]');
      const x = new XMLHttpRequest();
      x.open(req.method, 'https://api.github.com' + req.path, true);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/vnd.github+json');
      x.setRequestHeader('X-GitHub-Api-Version', '2022-11-28');
      x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      if (meta && meta.content) x.setRequestHeader('X-CSRF-Token', meta.content);
      if (req.body !== null) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = () => resolve(JSON.stringify({ status: x.status, ok: x.status >= 200 && x.status < 300, csrf: !!(meta && meta.content), body: String(x.responseText).slice(0, 5000) }));
      x.onerror = () => resolve(JSON.stringify({ status: 0, ok: false, error: 'XHR 网络错误（可能被 CORS 拦住）' }));
      x.send(req.body !== null ? JSON.stringify(req.body) : null);
    });
  })()`;
}

(async () => {
  const cmd = process.argv[2] || 'login';
  const c = await connect();
  try {
    if (cmd === 'login') {
      const info = await c.evaluate(`JSON.stringify({
        url: location.href,
        title: document.title,
        loggedIn: !!document.querySelector('meta[name=user-login]') || /github\\.com\\/(dashboard|settings)?$/.test(location.href) && !/\\/login/.test(location.href),
        userLogin: (document.querySelector('meta[name=user-login]') || {}).content || null,
        csrf: ((document.querySelector('meta[name=csrf-token]') || {}).content || '').slice(0, 8),
        hasLoginForm: !!document.querySelector('input[name=login]')
      })`);
      console.log(info);
    } else if (cmd === 'whoami') {
      console.log(await c.evaluate(apiExpr('GET', '/user', null)));
    } else if (cmd === 'shot') {
      console.log('已截图: ' + await c.shot(process.argv[3] || path.join(__dirname, 'shots', 'gh.png')));
    } else if (cmd === 'api') {
      const method = (process.argv[3] || 'GET').toUpperCase();
      const apiPath = process.argv[4];
      let body = null;
      if (process.argv[5]) body = JSON.parse(process.argv[5]);
      console.log(await c.evaluate(apiExpr(method, apiPath, body)));
    } else if (cmd === 'raw') {
      const js = fs.readFileSync(process.argv[3], 'utf8');
      console.log(await c.evaluate(js));
    } else {
      console.error('未知命令: ' + cmd);
      process.exitCode = 1;
    }
  } finally {
    try { c.ws.close(); } catch (e) {}
  }
  process.exit(0);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
