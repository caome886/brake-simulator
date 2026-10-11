// Netlify 发布：两种模式
//   node netlify-deploy.js                      新建站点（Netlify Drop，之后需认领）
//   node netlify-deploy.js --update <slug>      更新已有站点（往该项目的 Deploys 页上传整包）
// 需要先有一个带调试端口的 Chrome（默认 9399），并用 CDP_PORT 覆盖。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9399;

const argv = process.argv.slice(2);
const updateSlug = argv.includes('--update') ? argv[argv.indexOf('--update') + 1] : null;
const zipArg = argv.find(a => /\.zip$/i.test(a));
const ZIP = path.join(__dirname, zipArg || 'netlify-site.zip');

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
  if (!fs.existsSync(ZIP)) { console.error('✗ 整包不存在: ' + ZIP); process.exit(1); }

  const page = (await jget('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('DOM.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return '异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
    return r.result && r.result.result && r.result.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shots', name), Buffer.from(r.result.data, 'base64'));
    return name;
  };

  const target = updateSlug
    ? 'https://app.netlify.com/projects/' + updateSlug + '/deploys'
    : 'https://app.netlify.com/drop';
  const selector = updateSlug ? '#dropzone-file-upload' : 'input[type=file]';

  console.log('→ 打开 ' + target);
  await send('Page.navigate', { url: target });
  await sleep(updateSlug ? 8000 : 7000);
  console.log('  当前地址: ' + await evaluate('location.href'));

  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  if (!q.result.nodeId) { console.error('✗ 没找到上传控件 ' + selector); ws.close(); process.exit(1); }
  console.log('→ 上传 ' + path.basename(ZIP) + '（' + Math.round(fs.statSync(ZIP).size / 1024) + ' KB）');
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [ZIP] });

  // 轮询：更新模式下只要部署完成即可；新建模式需要拿到站点网址
  let url = '', done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const raw = await evaluate(`JSON.stringify({
      href: location.href,
      links: [].map.call(document.querySelectorAll('a[href]'), function(a){ return a.href; })
               .filter(function(h){ return /netlify\\.app/.test(h) && !/app\\.netlify\\.com/.test(h); }),
      text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 500)
    })`);
    let p; try { p = JSON.parse(raw); } catch (e) { continue; }
    if (updateSlug) {
      if (/published|已发布|Deployed|部署/i.test(p.text) && !/uploading|正在上传/i.test(p.text)) { done = true; break; }
    } else {
      const uniq = (p.links || []).filter((v, idx, arr) => arr.indexOf(v) === idx);
      if (uniq.length) { url = uniq.sort((a, b) => a.length - b.length)[0]; done = true; break; }
      if (/^https:\/\/[a-z0-9-]+\.netlify\.app/.test(p.href)) { url = p.href; done = true; break; }
    }
    if (i % 5 === 4) console.log('  部署中… (' + ((i + 1) * 3) + 's)');
  }

  if (updateSlug) {
    if (done) console.log('\n✓ 已更新站点: https://' + updateSlug + '.netlify.app/');
    else console.log('\n? 没确认到部署完成，请到 Deploys 页查看');
  } else if (url) {
    fs.writeFileSync(path.join(__dirname, 'netlify-url.txt'), url + '\n', 'utf8');
    console.log('\n✓ 新站点已发布: ' + url);
    console.log('  （未认领的站点 1 小时后过期且带密码，需在页面上 Claim this site 并改成 Public）');
  } else {
    console.log('\n✗ 没读到站点网址');
    console.log('  ' + await evaluate(`JSON.stringify({href: location.href, text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 500)})`));
  }
  console.log('截图: ' + await shot(updateSlug ? 'netlify-updated.png' : 'netlify-result.png'));
  ws.close();
  process.exit(done ? 0 : 1);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
