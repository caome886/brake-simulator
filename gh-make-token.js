// 用网页登录态自动生成一个 classic Personal Access Token（repo + workflow），
// 生成后自动从页面读回并写入 gh-token.txt —— 不需要手动复制粘贴。
//
//   node gh-make-token.js fill    只填写表单并报告勾选情况（不提交，用于确认）
//   node gh-make-token.js submit  填写并提交，成功后把 token 写入 gh-token.txt
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9399;
const TOKEN_FILE = path.join(__dirname, 'gh-token.txt');

function jget(p) {
  return new Promise((res, rej) => {
    const req = http.get('http://127.0.0.1:' + PORT + p, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mode = process.argv[2] || 'fill';
  const page = (await jget('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const net = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.includes('/settings/tokens')) net.push(m.params.request.method + ' ' + u.replace('https://github.com', ''));
    }
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return '异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
    return r.result && r.result.result && r.result.result.value;
  };

  console.log('→ 打开 token 创建页');
  await send('Page.navigate', { url: 'https://github.com/settings/tokens/new' });
  await sleep(5000);
  console.log('  地址: ' + await evaluate('location.href'));

  // 1) 填描述
  console.log('→ 填写描述');
  console.log('  ' + await evaluate(`(function(){
    var el = document.querySelector('input[name="oauth_access[description]"]');
    if (!el) return '找不到描述框';
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'brake-simulator-deploy');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return '描述 = ' + el.value;
  })()`));

  // 2) 勾选 repo + workflow
  console.log('→ 勾选权限 repo + workflow');
  console.log('  ' + await evaluate(`(function(){
    var want = { repo: true, workflow: true };
    var done = [];
    [].forEach.call(document.querySelectorAll('input[name="oauth_access[scopes][]"]'), function(cb){
      var scope = cb.getAttribute('value');
      if (want[scope] && !cb.checked) { cb.click(); done.push(scope); }
    });
    var checked = [].filter.call(document.querySelectorAll('input[name="oauth_access[scopes][]"]'), function(cb){ return cb.checked; })
                    .map(function(cb){ return cb.getAttribute('value'); });
    return '本次勾选: ' + JSON.stringify(done) + ' ｜ 当前已勾选: ' + JSON.stringify(checked);
  })()`));

  // 3) 检查表单状态
  console.log('→ 表单状态');
  console.log(await evaluate(`(function(){
    var f = document.querySelector('form[action="/settings/tokens"]');
    if (!f) return '找不到表单';
    var submit = f.querySelector('button[type=submit], input[type=submit]');
    return JSON.stringify({
      action: f.getAttribute('action'), method: f.getAttribute('method'),
      submitText: submit ? (submit.textContent.trim() || submit.value) : '无提交按钮',
      submitDisabled: submit ? submit.disabled : null,
      hasCsrf: !!f.querySelector('input[name=authenticity_token]'),
      expires: (f.querySelector('input[name="oauth_access[default_expires_at]"]') || {}).value || null
    }, null, 1);
  })()`));

  if (mode !== 'submit') {
    console.log('\\n（只填写未提交。确认无误后运行: node gh-make-token.js submit）');
    ws.close(); process.exit(0);
  }

  // 4) 提交
  net.length = 0;
  console.log('\\n→ 提交生成 token');
  console.log('  ' + await evaluate(`(function(){
    var f = document.querySelector('form[action="/settings/tokens"]');
    var submit = f && f.querySelector('button[type=submit], input[type=submit]');
    if (!submit) return '找不到提交按钮';
    submit.scrollIntoView({ block: 'center' });
    submit.click();
    return '已点击 ' + (submit.textContent.trim() || submit.value);
  })()`));

  // 5) 等待跳转并抓取 token
  let token = null, url = '';
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    url = await evaluate('location.href');
    const found = await evaluate(`(function(){
      var m = document.body.innerText.match(/\\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\\b/);
      if (m) return m[1];
      var el = document.querySelector('code, input[readonly], #new-oauth-token');
      return (el && el.value && /^(ghp_|github_pat_)/.test(el.value)) ? el.value : null;
    })()`);
    if (found && typeof found === 'string' && /^(ghp_|github_pat_)/.test(found)) { token = found; break; }
    if (/\/settings\/tokens$/.test(url)) break;   // 已跳回列表页，说明可能没抓到
  }

  console.log('  当前地址: ' + url);
  console.log('  网络请求: ' + JSON.stringify(net.slice(0, 5)));

  if (token) {
    fs.writeFileSync(TOKEN_FILE, token + '\n', 'utf8');
    console.log('✓ 已获取 token（' + token.slice(0, 7) + '…' + token.slice(-4) + '，长度 ' + token.length + '）');
    console.log('✓ 已写入 ' + TOKEN_FILE);
  } else {
    console.log('✗ 没抓到 token。页面提示：');
    console.log(await evaluate(`JSON.stringify([].map.call(document.querySelectorAll('[role=alert], .flash, .error'), function(e){ return (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200); }).filter(Boolean).slice(0,5))`));
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shots', 'gh-token-result.png'), Buffer.from(r.result.data, 'base64'));
    console.log('截图: shots/gh-token-result.png');
  }
  ws.close();
  process.exit(token ? 0 : 1);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
