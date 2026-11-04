// Headless test of the static web version (build/web) served under a sub path like GitHub Pages.
// usage: npm run web && node scripts/webtest.js [file.stp ...]   (default: two small files in testfiles/)
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const web = path.join(root, 'build', 'web');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 48000 + Math.floor(Math.random() * 50);
const BASE = '/StepViewer/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };

(async () => {
  let files = process.argv.slice(2).map((f) => path.resolve(f));
  if (!files.length) {
    const dir = path.join(root, 'testfiles');
    files = fs.readdirSync(dir).filter((f) => /\.(stp|step)$/i.test(f) && fs.statSync(path.join(dir, f)).size < 2e6).slice(0, 2).map((f) => path.join(dir, f));
  }
  if (!fs.existsSync(path.join(web, 'index.html'))) { console.error('build/web missing: run `npm run web` first'); process.exit(1); }
  const requests = [];
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push(u);
    if (!u.startsWith(BASE)) { res.writeHead(404); return res.end(); }
    const f = path.join(web, u.slice(BASE.length) || 'index.html');
    if (!f.startsWith(web) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(PORT, '127.0.0.1');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-web-'));
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: profile,
    args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1400,900'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}${BASE}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sv);
    const ev = (fn, ...a) => page.evaluate(fn, ...a);

    const btn = await ev(() => { const b = document.getElementById('btnUpdate'); return { text: b.textContent, hidden: b.classList.contains('hidden') }; });
    check(btn.text === '데스크톱 앱 받기' && !btn.hidden, 'update button becomes "데스크톱 앱 받기" in the web version', JSON.stringify(btn));

    await ev(() => window.__sv.workerAssetsReady);
    for (const f of files) {
      const n = await ev(() => window.__sv.tabs.length);
      await (await page.$('#fileInput')).uploadFile(f);
      await page.waitForFunction((k) => window.__sv.tabs.length > k && !window.__sv.tabs.some((t) => t.loading), { timeout: 300000 }, n);
      const t = await ev(() => { const t = window.__sv.tabs[window.__sv.tabs.length - 1]; return { parts: t.parts.length, tris: t.triCount, info: t.loadInfo || '' }; });
      check(t.parts > 0 && t.tris > 0, `opens ${path.basename(f)} in the browser`, JSON.stringify(t));
    }
    // reopening hits the IndexedDB cache
    const n = await ev(() => window.__sv.tabs.length);
    await (await page.$('#fileInput')).uploadFile(files[0]);
    await page.waitForFunction((k) => window.__sv.tabs.length > k && !window.__sv.tabs.some((t) => t.loading), { timeout: 300000 }, n);
    const again = await ev(() => window.__sv.tabs[window.__sv.tabs.length - 1].loadInfo || '');
    check(/캐시|cache/i.test(again), 'second open of the same file comes from the cache', again);

    // a SolidWorks assembly selected together with its part files (the browser has no access to sibling files)
    const asmDir = path.join(root, 'testfiles', 'sw', 'handcam');
    if (fs.existsSync(asmDir)) {
      const all = fs.readdirSync(asmDir).map((f) => path.join(asmDir, f));
      const k = await ev(() => window.__sv.tabs.length);
      await (await page.$('#fileInput')).uploadFile(...all);
      await page.waitForFunction((k) => window.__sv.tabs.length > k && !window.__sv.tabs.some((t) => t.loading), { timeout: 600000 }, k);
      const r = await ev((k) => window.__sv.tabs.slice(k).map((t) => ({ name: t.name, parts: t.parts.length, tris: t.triCount })), k);
      check(r.length >= 1 && r.every((t) => t.parts > 0 && t.tris > 0) && r.some((t) => /hand cam/.test(t.name || '')),
        'SolidWorks assembly + its parts selected together open as assembly tabs', JSON.stringify(r));
    }

    check(!requests.some((u) => u.includes('/api/')), 'no requests to the local-server API', requests.filter((u) => u.includes('/api/')).join(' '));
    check(requests.every((u) => u.startsWith(BASE)), 'every asset is loaded relative to the sub path', requests.filter((u) => !u.startsWith(BASE)).join(' '));
    check(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
  } catch (e) {
    check(false, 'exception', String(e && e.stack || e));
  } finally {
    await browser.close();
    srv.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
