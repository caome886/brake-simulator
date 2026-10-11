#!/usr/bin/env node
/*
 * 刹车模拟器 —— 一键发布到 GitHub（建仓库 + 推送源码 + 开启 GitHub Pages）
 * 只用 Node 内置模块，不需要安装 git。
 *
 * 凭据（三种任选其一，按优先级）：
 *   1) 环境变量  GITHUB_TOKEN / GH_TOKEN
 *   2) 本项目目录下的 gh-token.txt   （文件里只放一行 token，不要加引号）
 *
 * 用法：
 *   node deploy.js                     # 仓库名默认 brake-simulator
 *   node deploy.js my-repo-name        # 指定仓库名
 *   node deploy.js --check             # 只验证 token，不推送
 *
 * 需要的 token 权限：classic 勾 repo + workflow；
 *                   fine-grained 勾 Administration: Read and write + Contents: Read and write。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://api.github.com';
const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, 'gh-token.txt');

// 仓库里要包含的文件（相对路径 -> 说明）。gh-token.txt 永远不会被上传。
const FILES = [
  'index.html',
  'README.md',
  '.gitignore',
  'serve.js',
  'cdp-test.js',
  'cdp-mobile-test.js',
  'cdp-live-test.js',
  'deploy.js',
  'netlify-deploy.js',
  'gh-web.js',
  'gh-create-repo.js',
  'gh-make-token.js',
  'tools/crop-shots.py',
  'shots/01-idle.png',
  'shots/02-accelerating.png',
  'shots/03-braking-1000N.png',
  'shots/04-danger-1500N.png',
  'shots/05-pedal-broken.png',
  'shots/06-game-over.png',
  'shots/60-mobile-portrait.png',
  'shots/62-mobile-both.png',
  'shots/63-mobile-fail.png',
  'shots/64-mobile-autohide.png',
  'shots/65-mobile-landscape.png',
  'shots/70-live-pages.png',
  'shots/71-live-netlify.png'
];

function readToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env && env.trim()) return env.trim();
  if (fs.existsSync(TOKEN_FILE)) {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (t) return t;
  }
  return null;
}

async function api(method, url, body, token) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'brake-simulator-deploy',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const repoArg = argv.find(a => !a.startsWith('--'));
  const repo = repoArg || 'brake-simulator';

  const token = readToken();
  if (!token) {
    console.error('✗ 没找到 token。');
    console.error('  请把 token 存到：' + TOKEN_FILE + '（文件里只放一行 token）');
    console.error('  或设置环境变量 GITHUB_TOKEN。');
    process.exit(2);
  }

  // 1. 验证凭据
  const me = await api('GET', '/user', null, token);
  if (!me.ok) {
    console.error('✗ token 验证失败：HTTP ' + me.status + ' ' + (me.data && me.data.message || ''));
    if (me.status === 401) console.error('  可能已过期/被吊销，或者复制时多了空格。');
    if (me.status === 403) console.error('  权限不足，classic token 需要勾选 repo。');
    process.exit(3);
  }
  const owner = me.data.login;
  const scopes = me.headers.get('x-oauth-scopes');
  console.log('✓ 已登录：' + owner + (scopes ? '（classic scopes: ' + scopes + '）' : '（fine-grained token）'));
  if (checkOnly) return;

  // 2. 建仓库（已存在就复用）
  const getRepo = await api('GET', `/repos/${owner}/${repo}`, null, token);
  if (getRepo.ok) {
    console.log('• 仓库已存在，直接推送：' + getRepo.data.html_url);
  } else if (getRepo.status === 404) {
    const created = await api('POST', '/user/repos', {
      name: repo,
      description: '刹车模拟器 —— 2D 上帝视角开车小游戏，踩刹车踏板，力到 1600N 就断，然后遥遥领先。',
      homepage: `https://${owner}.github.io/${repo}/`,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    }, token);
    if (!created.ok) {
      console.error('✗ 建仓库失败：HTTP ' + created.status + ' ' + (created.data && created.data.message || ''));
      process.exit(4);
    }
    console.log('✓ 已创建仓库：' + created.data.html_url);
  } else {
    console.error('✗ 查询仓库失败：HTTP ' + getRepo.status + ' ' + (getRepo.data && getRepo.data.message || ''));
    process.exit(4);
  }

  // 3. 逐个文件写进仓库（Contents API：已存在则带 sha 更新）
  let pushed = 0, skipped = 0;
  for (const rel of FILES) {
    const abs = path.join(ROOT, rel.split('/').join(path.sep));
    if (!fs.existsSync(abs)) { console.log('• 跳过（本地没有）：' + rel); skipped++; continue; }
    const content = fs.readFileSync(abs).toString('base64');
    const url = `/repos/${owner}/${repo}/contents/${rel}`;
    const existing = await api('GET', url, null, token);
    const body = { message: '更新 ' + rel, content, branch: 'main' };
    if (existing.ok && existing.data && existing.data.sha) body.sha = existing.data.sha;
    const put = await api('PUT', url, body, token);
    if (!put.ok) {
      console.error('✗ 上传失败 ' + rel + '：HTTP ' + put.status + ' ' + (put.data && put.data.message || ''));
      process.exit(5);
    }
    console.log('✓ ' + rel + (existing.ok ? '（更新）' : '（新增）'));
    pushed++;
  }
  console.log(`\n源码已就绪：${pushed} 个文件写入，${skipped} 个跳过。`);

  // 4. 开启 GitHub Pages（main 分支根目录）
  let pagesStatus = '未开启';
  const pagesUrl = `https://api.github.com/repos/${owner}/${repo}/pages`;
  const existingPages = await api('GET', `/repos/${owner}/${repo}/pages`, null, token);
  if (existingPages.ok) {
    console.log('• Pages 已开启：' + existingPages.data.html_url);
    pagesStatus = existingPages.data.status || 'built';
  } else if (existingPages.status === 404) {
    const build = await api('POST', `/repos/${owner}/${repo}/pages`, { source: { branch: 'main', path: '/' } }, token);
    if (!build.ok) {
      console.error('⚠ Pages 自动开启失败：HTTP ' + build.status + ' ' + (build.data && build.data.message || ''));
      console.error('  可以手动开：仓库 Settings → Pages → Source 选 "Deploy from a branch" → main / (root)');
    } else {
      console.log('✓ Pages 已开启，首次构建通常 1~3 分钟。');
      pagesStatus = (build.data && build.data.status) || 'building';
    }
  } else {
    console.error('⚠ 查询 Pages 失败：HTTP ' + existingPages.status);
  }

  if (pagesStatus !== '未开启') {
    for (let i = 0; i < 20; i++) {
      await sleep(6000);
      const st = await api('GET', `/repos/${owner}/${repo}/pages`, null, token);
      if (st.ok && st.data.status === 'built') { console.log('✓ Pages 构建完成。'); break; }
      if (i === 19) console.log('• Pages 仍在构建中（status=' + (st.data && st.data.status) + '），稍后自行刷新即可。');
    }
  }

  console.log('\n========== 链接 ==========');
  console.log('仓库：       https://github.com/' + owner + '/' + repo);
  console.log('Pages：      https://' + owner + '.github.io/' + repo + '/');
  console.log('jsDelivr：   https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@main/index.html');
  console.log('（jsDelivr 首次访问需要回源抓取，可能要等 1~2 分钟或刷新一次）');
})().catch(e => { console.error('✗ 意外错误：' + (e && e.stack || e)); process.exit(1); });
