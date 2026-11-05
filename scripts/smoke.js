// Headless smoke/perf test with assertions. Exit code 1 on any failed check.
// usage: node scripts/smoke.js [file1.stp file2.stp ...]   (default: small files in testfiles/)
//   env SV_SHOTS=<dir>  -> save screenshots there
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 47900 + Math.floor(Math.random() * 50);
const SHOTS = process.env.SV_SHOTS || null;
const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** DXF LINE/ARC/CIRCLE -> closed loops; area = largest loop minus the others (outline with holes) */
function dxfLoops(text, scale = 1) {
  const t = text.split(/\r?\n/), ents = [];
  let cur = null, inEnt = false;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const code = t[i].trim(), val = t[i + 1].trim();
    if (code === '2' && val === 'ENTITIES') inEnt = true;
    if (!inEnt) continue;
    if (code === '0') { if (cur) ents.push(cur); cur = ['LINE', 'ARC', 'CIRCLE'].includes(val) ? { t: val } : null; } else if (cur) cur[code] = Number(val);
  }
  const circles = [], open = [];
  for (const e of ents) {
    if (e.t === 'CIRCLE') { circles.push(Math.PI * e[40] * e[40]); continue; }
    if (e.t === 'LINE') { open.push([[e[10], e[20]], [e[11], e[21]]]); continue; }
    let a0 = (e[50] * Math.PI) / 180, a1 = (e[51] * Math.PI) / 180;
    if (a1 <= a0) a1 += 2 * Math.PI;
    const pts = [];
    for (let k = 0; k <= 64; k++) { const a = a0 + ((a1 - a0) * k) / 64; pts.push([e[10] + e[40] * Math.cos(a), e[20] + e[40] * Math.sin(a)]); }
    open.push(pts);
  }
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3 * scale;
  const used = open.map(() => false), areas = [];
  let openLoops = 0;
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = open[i].slice();
    for (;;) {
      const end = loop[loop.length - 1];
      if (loop.length > 2 && near(end, loop[0])) break;
      const j = open.findIndex((p, k) => !used[k] && (near(p[0], end) || near(p[p.length - 1], end)));
      if (j < 0) { openLoops++; break; }
      used[j] = true;
      loop.push(...(near(open[j][0], end) ? open[j] : open[j].slice().reverse()).slice(1));
    }
    let a = 0;
    for (let k = 0; k < loop.length; k++) { const p = loop[k], q = loop[(k + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    areas.push(Math.abs(a / 2));
  }
  const all = [...areas, ...circles].sort((x, y) => y - x);
  return { loops: areas.length, circles: circles.length, openLoops, area: all.length ? all[0] - all.slice(1).reduce((s, x) => s + x, 0) : 0 };
}

(async () => {
  let files = process.argv.slice(2).map((f) => path.resolve(f));
  if (!files.length) {
    const dir = path.join(root, 'testfiles');
    files = fs.readdirSync(dir).filter((f) => /\.(stp|step)$/i.test(f) && fs.statSync(path.join(dir, f)).size < 2e6).map((f) => path.join(dir, f));
  }
  // mock GitHub "latest release" (no network in tests): a newer version without an exe asset
  const http = require('node:http');
  const mockRel = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: '99.0.0', html_url: 'https://example.invalid/releases/99.0.0', assets: [] }));
  }).listen(PORT + 100, '127.0.0.1');
  const srv = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], {
    env: { ...process.env, STEPVIEWER_NO_BROWSER: '1', STEPVIEWER_KEEPALIVE: '1', STEPVIEWER_UPDATE_API: `http://127.0.0.1:${PORT + 100}/latest` }, stdio: 'pipe',
  });
  await wait(600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-'));
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: profile,
    args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1600,1000'] });
  const errors = [];
  let serverGone = false;
  const post = (paths) => fetch(`http://127.0.0.1:${PORT}/api/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    const shot = async (n) => { if (!SHOTS) return; await wait(400); await page.screenshot({ path: path.join(SHOTS, `sv-${n}.png`) }); };
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sv);
    const ev = (fn, ...a) => page.evaluate(fn, ...a);
    const baseGeo = await ev(() => window.__sv.renderer.info.memory.geometries);

    // ---- update dialog: current version vs. latest release
    await page.click('#btnUpdate');
    await page.waitForFunction(() => document.getElementById('updLatest').textContent !== '확인 중…', { timeout: 20000 });
    const upd = await ev(() => ({ cur: document.getElementById('updCurrent').textContent, latest: document.getElementById('updLatest').textContent,
      msg: document.getElementById('updMsg').textContent, disabled: document.getElementById('btnUpdApply').disabled }));
    const pkgVer = require(path.join(root, 'package.json')).version;
    check(upd.cur === pkgVer && upd.latest === '99.0.0' && upd.disabled && /새 버전 99\.0\.0/.test(upd.msg), 'update check shows current/latest version (no exe asset -> update disabled)', JSON.stringify(upd));
    await page.keyboard.press('Escape');
    check(await ev(() => document.getElementById('updateDlg').classList.contains('hidden')), 'Escape closes the update dialog');

    // ---- load all files as tabs
    const t0 = Date.now();
    await post(files);
    await page.waitForFunction((n) => window.__sv.tabs.length >= n && !window.__sv.tabs.some((t) => t.loading), { timeout: 600000 }, files.length);
    const loads = await ev(() => window.__sv.stats().loadTimes);
    check(loads.length === files.length && loads.every((l) => l.parts > 0 && l.tris > 0), `${files.length} files loaded as tabs`, `${Date.now() - t0} ms`);
    for (const l of loads) console.log(`      ${l.name}: ${(l.ms / 1000).toFixed(2)} s, ${l.parts} parts, ${l.tris} tris`);

    // ---- reopen first file -> cache
    const t1 = Date.now();
    await post([files[0]]);
    await page.waitForFunction((n) => window.__sv.tabs.length > n && !window.__sv.tabs.some((t) => t.loading), { timeout: 300000 }, files.length);
    const info = await ev(() => window.__sv.tabs[window.__sv.tabs.length - 1].loadInfo);
    check(info.includes('캐시'), 'reopen uses parse cache', `${Date.now() - t1} ms (${info})`);
    await page.keyboard.down('Control'); await page.keyboard.press('w'); await page.keyboard.up('Control');

    // ---- FPS on the heaviest tab
    await ev(() => { const sv = window.__sv; const t = sv.tabs.slice().sort((a, b) => b.triCount - a.triCount)[0]; document.querySelectorAll('.tab')[sv.tabs.indexOf(t)].click(); });
    await wait(300);
    const perf = await ev(async () => {
      const sv = window.__sv; const tab = sv.active;
      let frames = 0; const t0 = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const off = tab.camera.position.clone().sub(tab.target);
          off.applyAxisAngle(new sv.THREE.Vector3(0, 0, 1), 0.03);
          tab.camera.position.copy(tab.target).add(off);
          tab.camera.lookAt(tab.target);
          sv.controls.dispatchEvent({ type: 'change' });
          frames++;
          if (performance.now() - t0 < 2500) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      return { name: tab.name, fps: frames / ((performance.now() - t0) / 1000), calls: sv.renderer.info.render.calls, tris: tab.triCount };
    });
    check(perf.fps > 30, `orbit FPS on heaviest model (${perf.name})`, `${perf.fps.toFixed(1)} fps, ${perf.calls} draw calls, ${perf.tris} tris`);

    // ---- switch to the first tab for feature checks
    await ev(() => { document.querySelector('.tab').click(); window.__sv.setView(window.__sv.active, 'iso', false); });
    await wait(400);
    await shot('1-loaded');
    const box = await ev(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

    // selection by click
    await page.mouse.click(cx, cy);
    const sel = await ev(() => [...window.__sv.active.selection].map((p) => p.name));
    check(sel.length === 1, 'click selects a part', JSON.stringify(sel));
    await shot('2-selected');

    // hide / show all
    const hidden0 = await ev(() => window.__sv.active.parts.filter((p) => !p.visible).length); // SolidWorks files may open with hidden parts
    await page.keyboard.press('h');
    const hidden = await ev(() => window.__sv.active.parts.filter((p) => !p.visible).length);
    check(hidden - hidden0 === 1, 'H hides selected part', `${hidden0} -> ${hidden}`);
    await page.keyboard.down('Shift'); await page.keyboard.press('H'); await page.keyboard.up('Shift');
    check(await ev(() => window.__sv.active.parts.every((p) => p.visible)), 'Shift+H shows all');

    // ---- right-click context menu (click without moving; right drag keeps panning)
    const menuOpen = () => ev(() => !document.getElementById('ctxMenu').classList.contains('hidden'));
    const rclick = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await wait(120); };
    const menuItem = (act) => page.click(`#ctxMenu [data-act="${act}"]`);
    await ev(() => window.__sv.selectParts([]));
    await rclick(cx, cy);
    const rsel = await ev(() => [...window.__sv.active.selection].map((p) => p.name));
    check(await menuOpen() && rsel.length === 1, 'right click on a part selects it and opens the menu', JSON.stringify(rsel));
    const camBefore = await ev(() => window.__sv.active.camera.position.toArray());
    await menuItem('hideOthers'); await wait(100);
    const afterOthers = await ev(() => { const t = window.__sv.active; return { vis: t.parts.filter((p) => p.visible).map((p) => p.name), n: t.parts.length, cam: t.camera.position.toArray() }; });
    check(!(await menuOpen()) && afterOthers.vis.length === 1 && afterOthers.vis[0] === rsel[0] && afterOthers.cam.every((v, i) => Math.abs(v - camBefore[i]) < 1e-9),
      'menu "hide others" leaves only the selection visible, camera unchanged', `${afterOthers.vis.length}/${afterOthers.n} visible`);
    await rclick(cx, cy);
    await menuItem('hide'); await wait(100);
    check(await ev(() => window.__sv.active.parts.every((p) => !p.visible) && window.__sv.active.selection.size === 0), 'menu "hide selection" hides the selected part');
    await rclick(cx, cy);
    const dis = await ev(() => [...document.querySelectorAll('#ctxMenu button')].map((b) => b.disabled));
    check(await menuOpen() && dis[0] && dis[1] && !dis[2], 'menu on empty space: hide items disabled, show all enabled', JSON.stringify(dis));
    await menuItem('showAll'); await wait(100);
    check(await ev(() => window.__sv.active.parts.every((p) => p.visible)), 'menu "show all" restores every part');
    const tgt0 = await ev(() => window.__sv.active.target.toArray());
    await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' }); await page.mouse.move(cx + 60, cy + 30, { steps: 6 }); await page.mouse.up({ button: 'right' }); await wait(150);
    const tgt1 = await ev(() => window.__sv.active.target.toArray());
    check(!(await menuOpen()) && tgt0.some((v, i) => Math.abs(v - tgt1[i]) > 1e-6), 'right drag pans without opening the menu');
    await ev(() => window.__sv.setView(window.__sv.active, 'iso', false)); await wait(300);
    await page.mouse.click(cx, cy); // keep a selection, then right click empty space
    await rclick(box.x + 30, box.y + box.h - 30);
    const dis2 = await ev(() => [...document.querySelectorAll('#ctxMenu button')].map((b) => b.disabled));
    check(await menuOpen() && dis2[0] && dis2[1] && (await ev(() => window.__sv.active.selection.size)) === 1, 'empty-space right click with a selection: hide items disabled', JSON.stringify(dis2));
    await page.keyboard.press('Escape');
    await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' }); await page.mouse.move(cx + 90, cy + 30, { steps: 6 }); await page.mouse.move(cx, cy, { steps: 6 }); await page.mouse.up({ button: 'right' }); await wait(150);
    check(!(await menuOpen()), 'right drag that returns to its start does not open the menu');
    await ev(() => window.__sv.setView(window.__sv.active, 'iso', false)); await wait(300);
    await rclick(cx, cy); await page.keyboard.press('Escape'); await wait(80);
    check(!(await menuOpen()), 'Escape closes the menu');
    if (await ev(() => window.__sv.active.nodes.length > 1)) {
      const row = await page.$('#tree .tnode:nth-child(2) .tname');
      const rb = await row.boundingBox();
      await page.mouse.click(rb.x + 5, rb.y + rb.height / 2, { button: 'right' }); await wait(120);
      const tsel = await ev(() => { const t = window.__sv.active; const n = t.nodes[Number(document.querySelector('#tree .tnode:nth-child(2)').dataset.nid)]; return n.partList.length > 0 && n.partList.every((p) => t.selection.has(p)); });
      check(await menuOpen() && tsel, 'right click in the tree selects that node and opens the menu');
      await page.keyboard.press('Escape');
    }
    await ev(() => window.__sv.selectParts([]));

    // distance measure via real clicks
    await page.keyboard.press('d');
    for (const [x, y] of [[cx - 60, cy + 10], [cx + 80, cy - 30]]) { await page.mouse.move(x, y); await wait(80); await page.mouse.click(x, y); }
    const ms = await ev(() => window.__sv.active.measures.map((m) => ({ type: m.type, text: m.lines[0] })));
    check(ms.length === 1 && ms[0].type === 'distance' && /\d/.test(ms[0].text), 'distance measurement created', ms[0] && ms[0].text.replace(/<[^>]+>/g, ''));
    await shot('3-measure');
    await page.keyboard.press('Escape');
    // Shift+C clears every measurement and the selection
    await ev(() => window.__sv.selectParts([window.__sv.active.parts[0]]));
    await page.keyboard.down('Shift'); await page.keyboard.press('C'); await page.keyboard.up('Shift');
    check(await ev(() => window.__sv.active.measures.length === 0 && window.__sv.active.selection.size === 0), 'Shift+C clears all measurements and the selection');

    // section with real caps
    await page.keyboard.press('x');
    await ev(() => document.querySelector('.sec-row[data-axis=y] .sec-on').click());
    const sec = await ev(() => ({ planes: window.__sv.active.clipPlanes.length, caps: window.__sv.active.caps.length }));
    check(sec.planes === 1 && sec.caps === 1, 'Y section creates 1 clip plane + 1 cap', JSON.stringify(sec));
    await shot('4-section');
    const capHit = await ev(() => {
      const sv = window.__sv; const r = document.getElementById('canvas').getBoundingClientRect();
      for (let y = 0.2; y < 0.85; y += 0.02) for (let x = 0.2; x < 0.85; x += 0.02) {
        const h = sv.pick({ clientX: r.left + r.width * x, clientY: r.top + r.height * y });
        if (h && h.cap) return true;
      }
      return false;
    });
    check(capHit, 'picking through the cut lands on the section cap');
    const grab = await ev(() => {
      const sv = window.__sv; const r = document.getElementById('canvas').getBoundingClientRect();
      for (let y = 0.15; y < 0.9; y += 0.02) for (let x = 0.15; x < 0.9; x += 0.02) {
        const e = { clientX: r.left + r.width * x, clientY: r.top + r.height * y };
        if (sv.sectionHandleAt(e, sv.pick(e))) return { x: e.clientX, y: e.clientY };
      }
      return null;
    });
    if (grab) {
      const before = await ev(() => ({ pos: window.__sv.active.section.y.pos, cam: window.__sv.active.camera.position.toArray() }));
      await page.mouse.move(grab.x, grab.y); await page.mouse.down(); await page.mouse.move(grab.x + 40, grab.y + 60, { steps: 8 }); await page.mouse.up(); await wait(150);
      const after = await ev(() => ({ pos: window.__sv.active.section.y.pos, cam: window.__sv.active.camera.position.toArray(), planes: window.__sv.active.clipPlanes.length }));
      check(Math.abs(after.pos - before.pos) > 1e-6 && after.planes === 1 && after.cam.every((v, i) => Math.abs(v - before.cam[i]) < 1e-4),
        'left drag on the section plane moves the section (camera unchanged)', `${before.pos.toFixed(3)} -> ${after.pos.toFixed(3)} planes ${after.planes} cam ${JSON.stringify(before.cam.map((v, i) => after.cam[i] - v))}`);
    } else check(false, 'left drag on the section plane moves the section', 'no grabbable plane point found');
    await ev(() => document.querySelector('.sec-row[data-axis=y] .sec-on').click());
    check(await ev(() => window.__sv.active.clipPlanes.length === 0 && window.__sv.active.caps.length === 0), 'section off removes planes and caps');
    await page.keyboard.press('x');

    // transparency: per part and global
    await ev(() => { const sv = window.__sv; sv.selectParts([sv.active.parts[0]]); const s = document.getElementById('selOpacity'); s.value = 20; s.dispatchEvent(new Event('input')); });
    check(await ev(() => { const p = window.__sv.active.parts[0]; return p.material.transparent && Math.abs(p.material.opacity - 0.2) < 1e-6; }), 'per-part opacity 20%');
    // color picker open -> selected part shows its real color (no selection tint); closing restores the tint
    const tinted = () => ev(() => { const p = window.__sv.active.parts[0]; return !p.material.color.equals(p.baseColor); });
    const tint0 = await tinted();
    // cancelable click: our handler runs, but the native popup (which would swallow later key presses) is not opened
    await ev(() => { const c = document.getElementById('selColor'); c.addEventListener('click', (e) => e.preventDefault(), { once: true }); c.dispatchEvent(new MouseEvent('click', { cancelable: true })); });
    const tintOpen = await tinted();
    await ev(() => { const c = document.getElementById('selColor'); c.value = '#ffffff'; c.dispatchEvent(new Event('input')); });
    const tintEdit = await tinted();
    await ev(() => document.getElementById('selColor').dispatchEvent(new Event('change')));
    check(tint0 && !tintOpen && !tintEdit && (await tinted()), 'color picker suppresses selection highlight while open', JSON.stringify([tint0, tintOpen, tintEdit]));
    check(await ev(() => { const p = window.__sv.active.parts[0]; const c = p.material.color; return p.baseColor.r > 0.99 && p.baseColor.b > 0.99 && c.b - c.r > 0.2; }),
      'a white part gets a visible selection highlight');
    await ev(() => { const g = document.getElementById('globalOpacity'); g.value = 50; g.dispatchEvent(new Event('input')); });
    check(await ev(() => window.__sv.active.parts.every((p) => p.material.transparent)), 'global opacity 50% applies to all');
    await shot('5-transparent');
    await ev(() => { const g = document.getElementById('globalOpacity'); g.value = 100; g.dispatchEvent(new Event('input')); });

    // views + projection toggle
    for (const v of ['front', 'top', 'right', 'iso']) { await ev((v) => window.__sv.setView(window.__sv.active, v), v); await wait(350); }
    await page.keyboard.press('p');
    check(await ev(() => window.__sv.active.isOrtho), 'P toggles orthographic');
    await page.keyboard.press('p');
    await wait(350);
    // vertical drag of ~180°: the camera must go over the top (no polar clamp), ending upside down
    await ev(() => window.__sv.selectParts([]));
    await page.mouse.move(cx, cy - box.h * 0.28); await page.mouse.down(); await page.mouse.move(cx, cy + box.h * 0.28, { steps: 30 }); await page.mouse.up(); await wait(900);
    const upZ = await ev(() => window.__sv.active.camera.up.z);
    check(upZ < -0.3, 'left drag rotates freely past the pole (no 180° limit)', `camera up.z ${upZ.toFixed(3)}`);
    await ev(() => window.__sv.setView(window.__sv.active, 'iso', false));
    check(await ev(() => window.__sv.active.camera.up.z > 0.999), 'standard views restore Z up');

    // ---- section accuracy on a synthetic model: outer box [-500,500]^3 containing inner box x∈[-300,-200]
    const synth = await ev(async () => {
      const sv = window.__sv; const T = sv.THREE;
      const box = (x0, y0, z0, x1, y1, z1, color) => {
        const P = [], N = [], I = [], E = [];
        const faces = [
          [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]],
          [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]],
          [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]]];
        faces.forEach((f, k) => {
          for (let i = 0; i < 4; i++) { P.push(...f[i]); N.push(...f[4]); E.push(...f[i], ...f[(i + 1) % 4]); }
          I.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
        });
        return { name: '', color, position: new Float32Array(P), normal: new Float32Array(N), index: new Uint16Array(I), colors: null,
          edges: new Float32Array(E), faceFirst: new Int32Array([0, 2, 4, 6, 8, 10]), faceLast: new Int32Array([1, 3, 5, 7, 9, 11]) };
      };
      const tab = sv.loadResult('synthetic', { tree: { name: 'synthetic', meshes: [], children: [{ name: 'outer', meshes: [0], children: [] }, { name: 'inner', meshes: [1], children: [] }] },
        meshes: [box(-500, -500, -500, 500, 500, 500, [0.6, 0.6, 0.7]), box(-300, -100, -100, -200, 100, 100, [0.9, 0.2, 0.2])] });
      // X section at 0 keeping x <= 0, camera on +X looking at the cut
      tab.section.x.on = true; tab.section.x.pos = 0; tab.section.x.flip = false;
      sv.applySection(tab);
      tab.target.set(0, 0, 0);
      tab.camera.position.set(3000, 0.001, 0.001); tab.camera.lookAt(tab.target); tab.camera.updateMatrixWorld();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.getElementById('canvas').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const h = sv.pick({ clientX: cx, clientY: cy });
      const out = { center: h && { cap: !!h.cap, x: h.point.x, part: h.part.name } };
      // snapping near the cap boundary must never return clipped geometry
      let bad = 0, n = 0;
      for (let fx = 0.2; fx <= 0.8; fx += 0.05) for (let fy = 0.2; fy <= 0.8; fy += 0.05) {
        const e = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, shiftKey: false };
        const hh = sv.pick(e); if (!hh) continue;
        const s = sv.snapHit(hh, e); n++;
        if (tab.clipPlanes.some((pl) => pl.distanceToPoint(s.point) < -1e-3)) bad++;
      }
      out.snapClipped = bad; out.snapSamples = n;
      // transparency + color on caps
      const g = document.getElementById('globalOpacity'); g.value = 50; g.dispatchEvent(new Event('input'));
      const c = document.getElementById('secColor'); c.value = '#00ff00'; c.dispatchEvent(new Event('input'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.capOpacity = tab.caps[0].bins.map((b) => b.opacity);
      out.capColor = tab.caps[0].capMat.color.getHexString();
      g.value = 100; g.dispatchEvent(new Event('input'));
      c.value = '#e8743b'; c.dispatchEvent(new Event('input'));
      // per-part opacity must carry over to that part's cap
      sv.selectParts([tab.parts[0]]);
      const so = document.getElementById('selOpacity'); so.value = 50; so.dispatchEvent(new Event('input'));
      out.partCapOpacity = tab.caps[0].bins.map((b) => [b.opacity, [...b.parts].map((p) => p.name)]);
      so.value = 100; so.dispatchEvent(new Event('input'));
      // grazing rays over box edges / 3-face vertices must not produce cap points outside the part
      const tgeo = new T.BoxGeometry(200, 200, 200).translate(-200, 0, 0);
      const threeBox = { name: '', color: [0.6, 0.6, 0.7], position: tgeo.attributes.position.array, normal: tgeo.attributes.normal.array,
        index: new Uint16Array(tgeo.index.array), colors: null, edges: new Float32Array(0),
        faceFirst: new Int32Array([0, 2, 4, 6, 8, 10]), faceLast: new Int32Array([1, 3, 5, 7, 9, 11]) };
      const cases = [
        { mesh: () => box(-300, -100, -100, -100, 100, 100, [0.6, 0.6, 0.7]), flip: false, cam: [2000, 2400, 0], at: [-300, 100, 0] },
        { mesh: () => box(-300, -100, -100, -100, 100, 100, [0.6, 0.6, 0.7]), flip: true, cam: [-2000, -2000, -1800], at: [-100, -100, 100] },
        { mesh: () => threeBox, flip: true, cam: [-2000, -2000, -1800], at: [-100, -100, 100] },
        { mesh: () => threeBox, flip: false, cam: [2000, 2400, 0], at: [-300, 100, 0] },
        { mesh: () => threeBox, flip: true, cam: [-2000, 1900, 1700], at: [-100, 100, -100] },
      ];
      let outside = 0, capHits = 0;
      for (const cs of cases) {
        const t2 = sv.loadResult('tangent', { tree: { name: 'tangent', meshes: [0], children: [] }, meshes: [cs.mesh()] });
        t2.section.x.on = true; t2.section.x.pos = -200; t2.section.x.flip = cs.flip;
        sv.applySection(t2);
        t2.target.set(...cs.at);
        t2.camera.position.set(...cs.cam); t2.camera.lookAt(t2.target); t2.camera.updateMatrixWorld();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
          const h = sv.pick({ clientX: cx + dx * 0.25, clientY: cy + dy * 0.25 });
          if (h && h.cap) { capHits++; if (!t2.box.clone().expandByScalar(1e-3).containsPoint(h.point)) outside++; }
        }
        // a ray straight through the middle of the cut must still be a cap hit
        t2.target.set(-200, 0, 0);
        t2.camera.position.set(cs.flip ? -2500 : 1500, 300, 200); t2.camera.lookAt(t2.target); t2.camera.updateMatrixWorld();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const mid = sv.pick({ clientX: cx, clientY: cy });
        if (!(mid && mid.cap)) out.midMiss = (out.midMiss || 0) + 1;
      }
      out.tangentOutside = outside; out.tangentCapHits = capHits;
      // radius on a half cylinder face (axis (1,2,3), r 5, length 20) and on a plane
      const ax = new T.Vector3(1, 2, 3).normalize(), uu = new T.Vector3().crossVectors(ax, new T.Vector3(1, 0, 0)).normalize(), ww = new T.Vector3().crossVectors(ax, uu);
      const C0 = new T.Vector3(10, -20, 30), P = [], N = [], I = [];
      const seg = 24;
      for (let i = 0; i <= seg; i++) {
        const a = (Math.PI * i) / seg, n = uu.clone().multiplyScalar(Math.cos(a)).addScaledVector(ww, Math.sin(a));
        for (const h of [0, 20]) { const p = C0.clone().addScaledVector(ax, h).addScaledVector(n, 5); P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); }
      }
      for (let i = 0; i < seg; i++) { const k = i * 2; I.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      const cyl = { name: 'halfcyl', color: [0.7, 0.7, 0.7], position: new Float32Array(P), normal: new Float32Array(N), index: new Uint16Array(I), colors: null,
        edges: new Float32Array(0), faceFirst: new Int32Array([0]), faceLast: new Int32Array([I.length / 3 - 1]) };
      const tc = sv.loadResult('cyl', { tree: { name: 'cyl', meshes: [0], children: [] }, meshes: [cyl] });
      const pt = new T.Vector3().fromArray(P, 12);
      const fit = sv.fitCylinderFace(tc, { part: tc.parts[0], tri: 3, point: pt });
      out.cyl = fit && { r: fit.radius, axisDot: Math.abs(fit.normal.dot(ax)), len: fit.length, centerOff: fit.center.clone().sub(C0).cross(ax).length() };
      const tp = sv.loadResult('plane', { tree: { name: 'plane', meshes: [0], children: [] }, meshes: [box(0, 0, 0, 10, 10, 10, [0.7, 0.7, 0.7])] });
      out.planeFit = sv.fitCylinderFace(tp, { part: tp.parts[0], tri: 0, point: new T.Vector3(10, 5, 5) });
      // a very flat cone (r 5 -> 5.01 over 1 mm) must not pass as a cylinder
      const CP = [], CN = [];
      for (let i = 0; i <= seg; i++) {
        const a = (2 * Math.PI * i) / seg, n = uu.clone().multiplyScalar(Math.cos(a)).addScaledVector(ww, Math.sin(a));
        const slope = 0.01, nn = n.clone().addScaledVector(ax, -slope).normalize();
        for (const [h, rr] of [[0, 5], [1, 5.01]]) { const p = C0.clone().addScaledVector(ax, h).addScaledVector(n, rr); CP.push(p.x, p.y, p.z); CN.push(nn.x, nn.y, nn.z); }
      }
      const cone = { ...cyl, name: 'cone', position: new Float32Array(CP), normal: new Float32Array(CN) };
      const tk = sv.loadResult('cone', { tree: { name: 'cone', meshes: [0], children: [] }, meshes: [cone] });
      out.coneFit = sv.fitCylinderFace(tk, { part: tk.parts[0], tri: 3, point: new T.Vector3().fromArray(CP, 12) });
      return out;
    });
    check(synth.center && synth.center.cap && Math.abs(synth.center.x) < 1e-3 && synth.center.part === 'outer', 'cap in front of a nested part is picked (outer cap at x=0)', JSON.stringify(synth.center));
    check(synth.snapClipped === 0 && synth.snapSamples > 0, 'snapping never lands on clipped geometry', `${synth.snapClipped}/${synth.snapSamples}`);
    check(synth.capOpacity.length === 1 && Math.abs(synth.capOpacity[0] - 0.5) < 1e-6, 'cap follows global opacity', JSON.stringify(synth.capOpacity));
    check(synth.partCapOpacity.length === 1 && Math.abs(synth.partCapOpacity[0][0] - 0.5) < 1e-6 && synth.partCapOpacity[0][1][0] === 'outer', 'cap follows per-part opacity', JSON.stringify(synth.partCapOpacity));
    check(!synth.midMiss, 'ray through the middle of a cut hits the cap (5 configurations)', String(synth.midMiss || 0));
    check(synth.tangentOutside === 0, 'grazing ray at an edge never yields a cap point outside the part', `${synth.tangentOutside} outside / ${synth.tangentCapHits} cap hits`);
    check(synth.capColor === '00ff00', 'section color change updates existing caps', synth.capColor);
    check(synth.cyl && Math.abs(synth.cyl.r - 5) < 1e-3 && synth.cyl.axisDot > 0.99999 && Math.abs(synth.cyl.len - 20) < 1e-3 && synth.cyl.centerOff < 1e-3,
      'radius on a half-cylinder face: R, axis, length, center', JSON.stringify(synth.cyl));
    check(synth.planeFit === null, 'a planar face is not taken for a cylinder');
    check(synth.coneFit === null, 'a very flat cone (0.57°) is not taken for a cylinder');
    await shot('6-synthetic');

    // ---- Parasolid X_T + face/edge/vertex picking, pair measurement, normal view, DXF export
    const xtFile = path.join(root, 'testfiles', 'xt', 'lens mount_261022 - Part 1.x_t');
    if (fs.existsSync(xtFile)) {
      const nT = await ev(() => window.__sv.tabs.length);
      await (await page.$('#fileInput')).uploadFile(xtFile);
      await page.waitForFunction((n) => window.__sv.tabs.length > n && !window.__sv.tabs.some((t) => t.loading), { timeout: 300000 }, nT);
      const xt = await ev(() => { const t = window.__sv.active; return { parts: t.parts.length, tris: t.triCount, name: t.parts[0] && t.parts[0].name, rgb: t.parts[0] && t.parts[0].rgb }; });
      check(xt.parts === 1 && xt.tris > 1000 && xt.name === 'Part 1' && Math.abs(xt.rgb[0] - 0.502) < 0.01, 'X_T part opens with the name and color stored in the file', JSON.stringify(xt));
      await ev(() => window.__sv.setView(window.__sv.active, 'iso', false)); await wait(300);
      // two planar faces, picked well inside (the same face 12 px around the point)
      const fp = await ev(() => {
        const sv = window.__sv, c = document.getElementById('canvas').getBoundingClientRect(), out = [], seen = new Set();
        const faceAt = (x, y) => { const h = sv.pick({ clientX: x, clientY: y }); if (!h || h.cap) return -1; const ff = h.part.faceFirst, fl = h.part.faceLast; for (let i = 0; i < ff.length; i++) if (h.tri >= ff[i] && h.tri <= fl[i]) return i; return -1; };
        for (let y = 0.25; y <= 0.75; y += 0.01) for (let x = 0.25; x <= 0.75; x += 0.01) {
          const X = c.left + c.width * x, Y = c.top + c.height * y, f = faceAt(X, Y);
          if (f < 0 || seen.has(f) || [[12, 0], [-12, 0], [0, 12], [0, -12]].some(([dx, dy]) => faceAt(X + dx, Y + dy) !== f)) continue;
          if (!sv.faceData(sv.active.parts[0], f).planar) continue;
          seen.add(f); out.push({ x: X, y: Y, f });
        }
        // a pair of faces that do not touch, so the distance is a real test
        const box = (f) => new sv.THREE.Box3().setFromBufferAttribute(new sv.THREE.BufferAttribute(sv.faceData(sv.active.parts[0], f).tri, 3));
        for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
          const a = box(out[i].f), b = box(out[j].f);
          const gap = Math.max(a.min.x - b.max.x, b.min.x - a.max.x, a.min.y - b.max.y, b.min.y - a.max.y, a.min.z - b.max.z, b.min.z - a.max.z);
          if (gap > 0.5) return [out[i], out[j]];
        }
        return out.slice(0, 2);
      });
      check(fp.length === 2, 'found two planar faces to pick', JSON.stringify(fp));
      if (fp.length === 2) {
        await page.mouse.click(fp[0].x, fp[0].y); await wait(80); // selects the part
        const selOnly = await ev(() => ({ sel: window.__sv.active.selection.size, ents: (window.__sv.active.entities || []).length }));
        await page.mouse.click(fp[0].x, fp[0].y); await wait(80); // second click: the face
        await page.mouse.click(fp[1].x, fp[1].y); await wait(150);
        const pair = await ev(() => {
          const sv = window.__sv, t = sv.active, [A, B] = t.entities;
          // brute force reference: every vertex of one face to every triangle of the other, both ways
          const T = new sv.THREE.Triangle(), q = new sv.THREE.Vector3(), p = new sv.THREE.Vector3();
          const fa = sv.faceData(A.part, A.f), fb = sv.faceData(B.part, B.f);
          let ref = Infinity;
          for (const [x, y] of [[fa, fb], [fb, fa]]) for (let i = 0; i < x.tri.length; i += 3) {
            p.fromArray(x.tri, i);
            for (let j = 0; j < y.tri.length; j += 9) { T.a.fromArray(y.tri, j); T.b.fromArray(y.tri, j + 3); T.c.fromArray(y.tri, j + 6); T.closestPointToPoint(p, q); ref = Math.min(ref, q.distanceTo(p)); }
          }
          return { kinds: t.entities.map((e) => e.kind), d: sv.closestBetween(A, B).d, ref, panel: document.getElementById('entityBody').innerText, visible: !document.getElementById('entityPanel').classList.contains('hidden') };
        });
        check(selOnly.sel === 1 && selOnly.ents === 0, 'first click selects the part only', JSON.stringify(selOnly));
        check(pair.visible && pair.kinds.join() === 'face,face' && /최단 거리/.test(pair.panel) && /면적/.test(pair.panel), 'second click picks a face, another face is measured against it', pair.kinds.join());
        check(pair.d <= pair.ref + 1e-6 && pair.ref - pair.d < 1e-3 + pair.ref * 1e-3, 'face-to-face distance matches a brute-force reference', `${pair.d.toFixed(5)} vs ${pair.ref.toFixed(5)}`);
        // many face pairs (and face-edge / edge-edge / vertex pairs) against brute force
        const many = await ev(() => {
          const sv = window.__sv, t = sv.active, part = t.parts[0], V = sv.THREE.Vector3;
          const T = new sv.THREE.Triangle(), q = new V(), p = new V(), c1 = new V(), c2 = new V();
          const faces = [];
          for (let f = 0; f < part.faceFirst.length && faces.length < 14; f++) faces.push({ kind: 'face', part, f, key: 'f' + f, viewNormal: new V(0, 0, 1), point: new V() });
          const ptTri = (pt, fd) => { let m = Infinity; for (let j = 0; j < fd.tri.length; j += 9) { T.a.fromArray(fd.tri, j); T.b.fromArray(fd.tri, j + 3); T.c.fromArray(fd.tri, j + 6); T.closestPointToPoint(pt, q); m = Math.min(m, q.distanceTo(pt)); } return m; };
          let worst = 0, pairs = 0, positive = 0;
          for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
            const fa = sv.faceData(part, faces[i].f), fb = sv.faceData(part, faces[j].f);
            let ref = Infinity;
            for (const [x, y] of [[fa, fb], [fb, fa]]) for (let k = 0; k < x.tri.length; k += 3) ref = Math.min(ref, ptTri(p.fromArray(x.tri, k), y));
            const d = sv.closestBetween(faces[i], faces[j]).d;
            // the reference only samples vertices, so the exact result may be smaller, never larger
            worst = Math.max(worst, d - ref, ref > 0 ? Math.min(ref - d, 0) : 0);
            if (d > ref + 1e-6) worst = Math.max(worst, d - ref);
            pairs++; if (ref > 0.01) positive++;
          }
          // an edge (polyline) of the part against a face: compare with dense sampling of the edge
          const e = part.edges, pts = [new V(e[0], e[1], e[2]), new V(e[3], e[4], e[5])];
          const edge = { kind: 'edge', part, pts, closed: false, key: 'e0' };
          let edgeWorst = 0;
          for (const fc of faces.slice(0, 6)) {
            const fd = sv.faceData(part, fc.f);
            let ref = Infinity;
            for (let k = 0; k <= 400; k++) ref = Math.min(ref, ptTri(c1.lerpVectors(pts[0], pts[1], k / 400), fd));
            edgeWorst = Math.max(edgeWorst, Math.abs(sv.closestBetween(edge, fc).d - ref));
          }
          const vtx = { kind: 'vertex', part, point: pts[0].clone(), key: 'v0' };
          const vErr = Math.abs(sv.closestBetween(vtx, faces[0]).d - ptTri(pts[0], sv.faceData(part, faces[0].f)));
          return { pairs, positive, worst, edgeWorst, vErr };
        });
        check(many.pairs > 20 && many.positive > 5 && many.worst < 1e-4 && many.edgeWorst < 2e-3 && many.vErr < 1e-6,
          'closest distance face-face / edge-face / vertex-face agrees with brute force', JSON.stringify(many));
        await page.mouse.click(fp[1].x, fp[1].y); await wait(80);
        check((await ev(() => window.__sv.active.entities.length)) === 1, 'clicking a picked face again releases it');
        // right click on the picked face: normal view + DXF
        await rclick(fp[0].x, fp[0].y);
        const fm = await ev(() => ({ open: !document.getElementById('ctxMenu').classList.contains('hidden'), nv: !document.querySelector('[data-act=normalView]').disabled, dxf: !document.querySelector('[data-act=exportDxf]').disabled }));
        check(fm.open && fm.nv && fm.dxf, 'right click on a picked plane offers normal view and DXF export', JSON.stringify(fm));
        await menuItem('normalView'); await wait(500);
        const nd = await ev(() => { const sv = window.__sv, t = sv.active, f = sv.actionFace(t); return t.camera.getWorldDirection(new sv.THREE.Vector3()).dot(sv.describeEntity(t, f).normal); });
        check(nd < -0.99999, 'normal view looks straight at the face', nd.toFixed(6));
        const dxfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dxf-'));
        await rclick(fp[0].x, fp[0].y);
        await menuItem('exportDxf');
        await page.waitForFunction(() => !document.getElementById('dxfDlg').classList.contains('hidden'));
        await page.waitForFunction(() => document.getElementById('dxfDir').value !== '', { timeout: 5000 }).catch(() => {});
        const dlg = await ev(() => ({ unit: document.getElementById('dxfUnit').value, dir: document.getElementById('dxfDir').value, name: document.getElementById('dxfName').value }));
        check(dlg.unit === 'mm' && dlg.dir && /\.dxf$/.test(dlg.name), 'DXF dialog: mm by default, folder and file name filled in', JSON.stringify(dlg));
        await ev((d) => { document.getElementById('dxfDir').value = d; document.getElementById('dxfName').value = 'face.dxf'; }, dxfDir);
        await page.click('#btnDxfCreate');
        await page.waitForFunction(() => document.getElementById('dxfDlg').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
        const dxfPath = path.join(dxfDir, 'face.dxf');
        const faceArea = await ev(() => { const sv = window.__sv; const f = sv.actionFace(sv.active); return sv.faceData(f.part, f.f).area; });
        const dx = fs.existsSync(dxfPath) ? dxfLoops(fs.readFileSync(dxfPath, 'utf8')) : null;
        check(dx && dx.openLoops === 0 && Math.abs(dx.area / faceArea - 1) < 0.005, 'DXF is written: closed outline whose area matches the face', dx ? `${JSON.stringify(dx)} vs face ${faceArea.toFixed(3)}` : 'no file');
        // the same name again: overwrite after confirmation
        await rclick(fp[0].x, fp[0].y);
        await menuItem('exportDxf');
        await page.waitForFunction(() => !document.getElementById('dxfDlg').classList.contains('hidden'));
        await ev((d) => { document.getElementById('dxfDir').value = d; document.getElementById('dxfName').value = 'face.dxf'; document.getElementById('dxfUnit').value = 'in'; }, dxfDir);
        page.once('dialog', (d) => d.accept());
        await page.click('#btnDxfCreate');
        await page.waitForFunction(() => document.getElementById('dxfDlg').classList.contains('hidden'), { timeout: 10000 }).catch(() => {});
        const dxIn = fs.existsSync(dxfPath) ? dxfLoops(fs.readFileSync(dxfPath, 'utf8'), 1 / 25.4) : null;
        check(dxIn && /\$INSUNITS\r\n70\r\n1\r\n/.test(fs.readFileSync(dxfPath, 'utf8')) && Math.abs(dxIn.area * 25.4 * 25.4 / faceArea - 1) < 0.005, 'an existing file is overwritten after confirmation; inch units scale the outline', dxIn ? dxIn.area.toFixed(4) + ' in²' : 'no file');
        fs.rmSync(dxfDir, { recursive: true, force: true });
        await page.keyboard.press('Escape'); await wait(60);
        const esc1 = await ev(() => ({ ents: window.__sv.active.entities.length, sel: window.__sv.active.selection.size }));
        await page.keyboard.press('Escape'); await wait(60);
        const esc2 = await ev(() => window.__sv.active.selection.size);
        check(esc1.ents === 0 && esc1.sel === 1 && esc2 === 0, 'Escape releases picked faces first, then the selection', JSON.stringify({ ...esc1, then: esc2 }));
      }
      await shot('7-xt');
    } else console.log('SKIP  X_T checks (testfiles/xt/lens mount_261022 - Part 1.x_t not found)');

    // ---- picked-entity math on synthetic faces (no sample files needed)
    const syn = await ev(() => {
      const sv = window.__sv, T = sv.THREE, V = T.Vector3, out = {};
      const mesh = (name, P, I, faces, edges = []) => ({ name, color: [0.7, 0.7, 0.7], position: new Float32Array(P), normal: null, index: new Uint32Array(I), colors: null,
        edges: new Float32Array(edges), faceFirst: Int32Array.from(faces, (f) => f[0]), faceLast: Int32Array.from(faces, (f) => f[1]) });
      const load = (name, m) => { const t = sv.loadResult(name, { tree: { name, meshes: [0], children: [] }, meshes: [m] }); sv.selectParts([t.parts[0]]); return t; };
      const face = (part, f) => ({ kind: 'face', part, f, key: 'f' + f, viewNormal: new V(0, 0, 1), point: new V() });
      // two planes and two lines 0.5 degrees apart are not parallel
      const a = (0.5 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const t1 = load('tilt', mesh('tilt', [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10 * c, 10 + 10 * s, 0, 10 * c, 10 + 10 * s], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], [[0, 1], [2, 3]]));
      out.planes = sv.measurePair(t1, face(t1.parts[0], 0), face(t1.parts[0], 1)).lines.join(' | ');
      const line = (p, q, k) => ({ kind: 'edge', part: t1.parts[0], pts: [p, q], closed: false, length: p.distanceTo(q), key: k });
      out.lines = sv.measurePair(t1, line(new V(0, 0, 0), new V(10, 0, 0), 'l1'), line(new V(0, 0, 5), new V(10 * c, 10 * s, 5), 'l2')).lines.join(' | ');
      // a long edge above a tiny triangle that lies between any coarse samples: the true minimum is 1
      const t2 = load('fork', mesh('fork', [436.95, -0.05, 0, 437.05, -0.05, 0, 437, 0.05, 0, 0, 200, -50, 1000, 200, -50, 500, 300, -50], [0, 1, 2, 3, 4, 5], [[0, 1]]));
      out.edgeFace = sv.closestBetween({ kind: 'edge', part: t2.parts[0], pts: [new V(0, 0, 1), new V(1000, 0, 1)], closed: false, key: 'e' }, face(t2.parts[0], 0)).d;
      // the same far from the origin (float32 sphere centers rounded the closest triangle away)
      out.far = [0, 1e6].map((X) => {
        const pts = [[0, 0], [0, 0.0625], [0.0625, 0.0625], [0.0625, 0.01], [0.125, 0.01], [0.125, 0.125], [-0.0625, 0.125], [-0.0625, 0]];
        const sh = new T.Shape(); sh.moveTo(...pts[0]); for (const q of pts.slice(1)) sh.lineTo(...q); sh.closePath();
        const g = new T.ShapeGeometry(sh), Pp = Array.from(g.attributes.position.array);
        for (let i = 0; i < Pp.length; i += 3) Pp[i] += X;
        const k = Pp.length / 3; Pp.push(X, 0, 0, X + 0.0625, 0, 0, X, 0.0625, 0);
        const Ii = Array.from(g.index.array); Ii.push(k, k + 1, k + 2);
        const tf = load('far' + X, mesh('far', Pp, Ii, [[0, Ii.length / 3 - 1]]));
        const ea = new V(X + 0.0625, 0, 0.001), eb = new V(X + 0.0625, 0, 0.002);
        return sv.closestBetween({ kind: 'edge', part: tf.parts[0], pts: [ea, eb], closed: false, key: 'e' }, face(tf.parts[0], 0)).d;
      });
      // a disk whose rim has one CAD vertex (an extra edge leaves it): DXF gets a CIRCLE, not a zero-length ARC
      const P = [0, 0, 0], I = [], E = [], n = 64;
      for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; P.push(10 * Math.cos(t), 10 * Math.sin(t), 0); }
      for (let i = 0; i < n; i++) { I.push(0, 1 + i, 1 + ((i + 1) % n)); E.push(P[3 + i * 3], P[4 + i * 3], 0, P[3 + ((i + 1) % n) * 3], P[4 + ((i + 1) % n) * 3], 0); }
      E.push(10, 0, 0, 10, 0, -5);
      const t3 = load('disk', mesh('disk', P, I, [[0, n - 1]], E));
      const ol = sv.faceOutline(t3, face(t3.parts[0], 0));
      out.disk = ol ? ol.ents.map((e) => e.t + (e.t === 'arc' ? `(${e.a0.toFixed(1)}..${e.a1.toFixed(1)})` : '')).join(',') : 'none';
      // edge highlights are clipped by the section like the model
      sv.setEntities(t3, [{ kind: 'edge', part: t3.parts[0], pts: [new V(10, 0, 0), new V(10, 0, -5)], closed: false, length: 5, key: 'x' }]);
      out.clip = t3.entGroup.children.filter((o) => o.material && o.material.clippingPlanes === t3.clipPlanes).length;
      sv.setEntities(t3, [face(t3.parts[0], 0)]);
      sv.openDxfDialog(t3, face(t3.parts[0], 0));
      return out;
    });
    check(/면 사이 각도 0\.500°|사잇각 0\.500°/.test(syn.planes) && !/평행 평면/.test(syn.planes), 'planes 0.5° apart are not called parallel', syn.planes);
    check(/직선 사이 각도 0\.500°/.test(syn.lines) && !/평행 직선/.test(syn.lines), 'lines 0.5° apart are not called parallel', syn.lines);
    check(Math.abs(syn.edgeFace - 1) < 1e-6, 'edge-to-face distance finds a narrow global minimum', String(syn.edgeFace));
    check(syn.far.every((d) => Math.abs(d - 0.001) < 1e-6), 'edge-to-face distance is the same 1,000,000 mm from the origin', JSON.stringify(syn.far));
    check(syn.disk === 'circle', 'DXF: a circular outline with one CAD vertex becomes a CIRCLE', syn.disk);
    check(syn.clip === 1, 'picked edge highlight uses the section clipping planes', String(syn.clip));
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dxfName', { timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Escape'); await wait(80);
    check(await ev(() => document.getElementById('dxfDlg').classList.contains('hidden')), 'Escape closes the DXF dialog while its file name has the focus');

    // ---- a new worker must start even when the local server is gone (it is prefetched as blobs)
    await ev(async () => { await window.__sv.workerAssetsReady; for (const w of window.__sv.pool.all.slice()) window.__sv.pool.kill(w); });
    srv.kill(); serverGone = true;
    await wait(500);
    await ev(() => { document.getElementById('quality').value = 'fine'; }); // other cache key -> real parse
    const nTabs = await ev(() => window.__sv.tabs.length);
    await (await page.$('#fileInput')).uploadFile(files.find((f) => /\.(stp|step)$/i.test(f)) || files[0]);
    await page.waitForFunction((n) => window.__sv.tabs.length > n && !window.__sv.tabs.some((t) => t.loading), { timeout: 600000 }, nTabs).catch(() => {});
    const offline = await ev(() => { const t = window.__sv.tabs[window.__sv.tabs.length - 1]; return { parts: t.parts.length, info: t.loadInfo || '' }; });
    check(offline.parts > 0 && !offline.info.includes('캐시'), 'a file opens after the server is gone (worker from prefetched blobs)', offline.info);
    await ev(() => { document.getElementById('quality').value = 'normal'; });

    // ---- leak check: close all tabs (with a section on + a pending measurement) and compare GPU geometry count
    await page.keyboard.press('x');
    await ev(() => document.querySelector('.sec-row[data-axis=z] .sec-on').click());
    await page.keyboard.press('x');
    await page.keyboard.press('d');
    await page.mouse.move(cx, cy); await wait(80); await page.mouse.click(cx, cy);
    await wait(100);
    while (await ev(() => window.__sv.tabs.length)) { await page.keyboard.down('Control'); await page.keyboard.press('w'); await page.keyboard.up('Control'); await wait(80); }
    await wait(300);
    const geo = await ev(() => window.__sv.renderer.info.memory.geometries);
    const keep = await ev(() => window.__sv.persistentGeometries);
    check(geo <= baseGeo + keep, 'no GPU geometry left after closing all tabs', `${geo} (baseline ${baseGeo} + ${keep} origin marker)`);
    // once the server is gone, the event stream's reconnect attempts fail by design
    const real = errors.filter((x) => !(serverGone && /ERR_CONNECTION_(REFUSED|RESET)/.test(x)));
    check(real.length === 0, 'no console errors', real.join(' | '));
  } finally {
    await browser.close();
    srv.kill();
    mockRel.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
