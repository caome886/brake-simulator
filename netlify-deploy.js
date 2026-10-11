// 一条命令完成：打开 Netlify Drop → 上传整包 → 轮询读取生成的站点网址
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.CDP_PORT || 9399;
const ZIP = path.join(__dirname, process.argv[2] || 'netlify-site.zip');

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
  if (!fs.existsSync(ZIP)) { console.error('整包不存在: ' + ZIP); process.exit(1); }
  const page = (await jget('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const net = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent' && /api\.netlify\.com/.test(m.params.request.url) && /deploys/.test(m.params.request.url)) {
      net.push(m.params.request.url.slice(0, 100));
    }
  });
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('DOM.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return '异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
    return r.result && r.result.result && r.result.result.value;
  };

  console.log('→ 打开 Netlify Drop');
  await send('Page.navigate', { url: 'https://app.netlify.com/drop' });
  await sleep(7000);
  console.log('  当前地址: ' + await evaluate('location.href'));

  // 塞入 zip
  const doc = await send('DOM.getDocument', { depth: -1 });
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  if (!q.result.nodeId) { console.error('✗ 没找到文件输入框'); ws.close(); process.exit(1); }
  console.log('→ 上传 ' + path.basename(ZIP) + '（' + Math.round(fs.statSync(ZIP).size / 1024) + ' KB）');
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [ZIP] });

  // 轮询等待站点网址出现
  let url = '';
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const raw = await evaluate(`JSON.stringify({
      href: location.href,
      links: [].map.call(document.querySelectorAll('a[href]'), function(a){ return a.href; })
               .filter(function(h){ return /netlify\\.app/.test(h) && !/app\\.netlify\\.com/.test(h); }),
      text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 400)
    })`);
    let p; try { p = JSON.parse(raw); } catch (e) { continue; }
    const uniq = (p.links || []).filter((v, idx, arr) => arr.indexOf(v) === idx);
    if (uniq.length) { url = uniq.sort((a, b) => a.length - b.length)[0]; break; }
    if (/^https:\/\/[a-z0-9-]+\.netlify\.app/.test(p.href)) { url = p.href; break; }
    if (i % 4 === 3) console.log('  等待部署完成… (' + ((i + 1) * 3) + 's) ' + p.text.slice(0, 120));
  }

  if (url) {
    fs.writeFileSync(path.join(__dirname, 'netlify-url.txt'), url + '\n', 'utf8');
    console.log('\n✓ Netlify 站点已发布: ' + url);
    console.log('✓ 已写入 netlify-url.txt');
  } else {
    console.log('\n✗ 没读到站点网址。上传请求数: ' + net.length);
    console.log('  页面状态: ' + await evaluate(`JSON.stringify({href: location.href, text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 700)})`));
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'shots', 'netlify-result.png'), Buffer.from(r.result.data, 'base64'));
  console.log('截图: shots/netlify-result.png');
  ws.close();
  process.exit(url ? 0 : 1);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
