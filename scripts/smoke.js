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

(async () => {
  let files = process.argv.slice(2).map((f) => path.resolve(f));
  if (!files.length) {
    const dir = path.join(root, 'testfiles');
    files = fs.readdirSync(dir).filter((f) => /\.(stp|step)$/i.test(f) && fs.statSync(path.join(dir, f)).size < 2e6).map((f) => path.join(dir, f));
  }
  const srv = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], {
    env: { ...process.env, STEPVIEWER_NO_BROWSER: '1', STEPVIEWER_KEEPALIVE: '1' }, stdio: 'pipe',
  });
  await wait(600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-'));
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: profile,
    args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1600,1000'] });
  const errors = [];
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
    await ev(() => document.querySelector('.sec-row[data-axis=y] .sec-on').click());
    check(await ev(() => window.__sv.active.clipPlanes.length === 0 && window.__sv.active.caps.length === 0), 'section off removes planes and caps');
    await page.keyboard.press('x');

    // transparency: per part and global
    await ev(() => { const sv = window.__sv; sv.selectParts([sv.active.parts[0]]); const s = document.getElementById('selOpacity'); s.value = 20; s.dispatchEvent(new Event('input')); });
    check(await ev(() => { const p = window.__sv.active.parts[0]; return p.material.transparent && Math.abs(p.material.opacity - 0.2) < 1e-6; }), 'per-part opacity 20%');
    // color picker open -> selected part shows its real color (no selection tint); closing restores the tint
    const emis = () => ev(() => window.__sv.active.parts[0].material.emissive.getHex());
    const selTint = await emis();
    // cancelable click: our handler runs, but the native popup (which would swallow later key presses) is not opened
    await ev(() => { const c = document.getElementById('selColor'); c.addEventListener('click', (e) => e.preventDefault(), { once: true }); c.dispatchEvent(new MouseEvent('click', { cancelable: true })); });
    const tintOpen = await emis();
    await ev(() => { const c = document.getElementById('selColor'); c.value = '#ff0000'; c.dispatchEvent(new Event('input')); });
    const tintEdit = await emis();
    await ev(() => document.getElementById('selColor').dispatchEvent(new Event('change')));
    check(selTint !== 0 && tintOpen === 0 && tintEdit === 0 && (await emis()) === selTint, 'color picker suppresses selection highlight while open', JSON.stringify([selTint, tintOpen, tintEdit]));
    await ev(() => { const g = document.getElementById('globalOpacity'); g.value = 50; g.dispatchEvent(new Event('input')); });
    check(await ev(() => window.__sv.active.parts.every((p) => p.material.transparent)), 'global opacity 50% applies to all');
    await shot('5-transparent');
    await ev(() => { const g = document.getElementById('globalOpacity'); g.value = 100; g.dispatchEvent(new Event('input')); });

    // views + projection toggle
    for (const v of ['front', 'top', 'right', 'iso']) { await ev((v) => window.__sv.setView(window.__sv.active, v), v); await wait(350); }
    await page.keyboard.press('p');
    check(await ev(() => window.__sv.active.isOrtho), 'P toggles orthographic');
    await page.keyboard.press('p');

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
      return out;
    });
    check(synth.center && synth.center.cap && Math.abs(synth.center.x) < 1e-3 && synth.center.part === 'outer', 'cap in front of a nested part is picked (outer cap at x=0)', JSON.stringify(synth.center));
    check(synth.snapClipped === 0 && synth.snapSamples > 0, 'snapping never lands on clipped geometry', `${synth.snapClipped}/${synth.snapSamples}`);
    check(synth.capOpacity.length === 1 && Math.abs(synth.capOpacity[0] - 0.5) < 1e-6, 'cap follows global opacity', JSON.stringify(synth.capOpacity));
    check(synth.partCapOpacity.length === 1 && Math.abs(synth.partCapOpacity[0][0] - 0.5) < 1e-6 && synth.partCapOpacity[0][1][0] === 'outer', 'cap follows per-part opacity', JSON.stringify(synth.partCapOpacity));
    check(!synth.midMiss, 'ray through the middle of a cut hits the cap (5 configurations)', String(synth.midMiss || 0));
    check(synth.tangentOutside === 0, 'grazing ray at an edge never yields a cap point outside the part', `${synth.tangentOutside} outside / ${synth.tangentCapHits} cap hits`);
    check(synth.capColor === '00ff00', 'section color change updates existing caps', synth.capColor);
    await shot('6-synthetic');

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
    check(geo <= baseGeo, 'no GPU geometry left after closing all tabs', `${geo} (baseline ${baseGeo})`);
    check(errors.length === 0, 'no console errors', errors.join(' | '));
  } finally {
    await browser.close();
    srv.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
