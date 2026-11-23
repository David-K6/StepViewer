// Phone / tablet layout and touch test (headless Edge with touch emulation). Exit code 1 on any failed check.
// usage: node scripts/mobiletest.js [model.stp]      env SV_SHOTS=<dir> saves screenshots
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 48900 + Math.floor(Math.random() * 50);
const SHOTS = process.env.SV_SHOTS || null;
const MODEL = path.resolve(process.argv[2] || path.join(root, 'testfiles', 'as1-oc-214.stp'));
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
// name, width, height, device pixel ratio, compact (phone) layout expected
const DEVICES = [
  ['iPhone SE', 375, 667, 2, true], ['iPhone 14', 390, 844, 3, true], ['Galaxy S20', 360, 800, 3, true],
  ['Pixel 7', 412, 915, 2.625, true], ['phone landscape', 844, 390, 3, true], ['Galaxy Fold (folded)', 280, 653, 3, true],
  ['iPhone 5 / SE 1st', 320, 568, 2, true], ['iPhone Pro Max', 430, 932, 3, true], ['small landscape', 667, 375, 2, true], ['Pixel landscape', 915, 412, 2.625, true],
  ['iPad mini', 768, 1024, 2, true], ['iPad landscape', 1024, 768, 2, false],
];
const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(MODEL)) { console.error(`model not found: ${MODEL}`); process.exit(2); }
  const srv = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], { env: { ...process.env, STEPVIEWER_NO_BROWSER: '1', STEPVIEWER_KEEPALIVE: '1' }, stdio: 'ignore' });
  await wait(700);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-mobile-'));
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: profile, args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
  try {
    for (const [dev, W, H, dpr, compact] of DEVICES) {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      await page.emulate({ userAgent: UA, viewport: { width: W, height: H, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, isLandscape: W > H } });
      const cdp = await page.target().createCDPSession();
      const tag = (s) => `[${dev}] ${s}`;
      const ev = (fn, ...a) => page.evaluate(fn, ...a);
      const shot = async (n) => { if (SHOTS) { await wait(250); await page.screenshot({ path: path.join(SHOTS, `${dev.replace(/\W+/g, '_')}-${n}.png`) }); } };
      const rect = (sel) => ev((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, shown: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' }; }, sel);
      const inside = (r, m = 0.5) => r && r.shown && r.x >= -m && r.y >= -m && r.r <= W + m && r.b <= H + m;
      const overlap = (a, b) => a && b && a.shown && b.shown && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
      const tap = async (x, y) => { await page.touchscreen.tap(x, y); await wait(120); };
      const tapSel = async (sel) => {
        await ev((s) => document.querySelector(s).scrollIntoView({ block: 'nearest', inline: 'nearest' }), sel); await wait(120);
        const r = await rect(sel); await tap(r.x + r.w / 2, r.y + r.h / 2);
      };
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });

      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__sv);
      // ---- layout without a model
      const meta = await ev(() => document.querySelector('meta[name=viewport]').content);
      check(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\D|$)/.test(meta), tag('page zoom is not blocked (accessibility)'), meta);
      const lay0 = await ev(() => ({ docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight }));
      check(lay0.docW <= W && lay0.docH <= H, tag('no page overflow (empty)'), JSON.stringify(lay0));
      await shot('0-empty');
      await (await page.$('#fileInput')).uploadFile(MODEL);
      await page.waitForFunction(() => window.__sv.tabs.length && !window.__sv.tabs.some((t) => t.loading), { timeout: 120000 });
      await wait(300);
      const lay = await ev(() => ({ docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, canvasW: document.getElementById('canvas').getBoundingClientRect().width }));
      check(lay.docW <= W && lay.docH <= H, tag('no page overflow (model open)'), JSON.stringify(lay));
      if (compact) check(Math.abs(lay.canvasW - W) < 1, tag('3D view uses the full width'), `${lay.canvasW} / ${W}`);
      const topItems = await ev(() => [...document.querySelectorAll('#topbar > button, #topbar > .btn')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, x: r.left, r: r.right, h: r.height }; }));
      check(topItems.every((b) => b.x >= 0 && b.r <= W + 0.5), tag('top bar buttons inside the screen'), JSON.stringify(topItems.map((b) => `${b.id}:${Math.round(b.x)}-${Math.round(b.r)}`)));
      const tools = await ev(() => [...document.querySelectorAll('#toolbar .tool')].filter((t) => getComputedStyle(t).display !== 'none').map((t) => { const r = t.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
      check(tools.every((t) => t.h >= (compact ? 40 : 30) && t.w >= 36), tag('tool buttons are large enough to touch'), `min ${Math.min(...tools.map((t) => t.h))} px`);
      const tb = await rect('#toolbar');
      check(inside(tb), tag('toolbar inside the screen'), JSON.stringify(tb));
      // every tool can be reached by scrolling the row
      await ev(() => { const t = document.getElementById('toolbar'); t.scrollLeft = t.scrollWidth; });
      await wait(150);
      const reach = await ev(() => {
        const t = document.getElementById('toolbar');
        const last = [...t.querySelectorAll('.group')].pop().getBoundingClientRect();
        return { ok: last.right <= window.innerWidth + 0.5 && last.left >= 0, fade: t.classList.contains('more-left') || t.scrollWidth <= t.clientWidth, scrolls: t.scrollWidth > t.clientWidth };
      });
      await ev(() => { document.getElementById('toolbar').scrollLeft = 0; });
      await wait(150);
      const fadeRight = await ev(() => document.getElementById('toolbar').classList.contains('more-right'));
      check(reach.ok && reach.fade && (!reach.scrolls || fadeRight), tag('every tool reachable; the scrolling row shows a faded edge'), JSON.stringify({ ...reach, fadeRight }));
      await shot('1-model');

      if (compact) {
        // ---- tree drawer
        check(!(await rect('#left')).shown || (await rect('#left')).r <= 0.5, tag('tree drawer closed by default'));
        await tapSel('#btnTree');
        // wait for the slide-in to finish instead of a fixed delay
        await page.waitForFunction(() => Math.abs(document.getElementById('left').getBoundingClientRect().left) < 0.5, { timeout: 3000 }).catch(() => {});
        const drawer = await rect('#left');
        const rowH = await ev(() => { const r = document.querySelector('#tree .tnode'); return r ? r.getBoundingClientRect().height : 0; });
        check(inside(drawer) && drawer.w >= Math.min(W * 0.8, 300) && rowH >= 36, tag('☰ opens the tree drawer with touch-size rows'), `${Math.round(drawer.x)}..${Math.round(drawer.r)} rows ${rowH}px`);
        await shot('2-drawer');
        await tap(W - 12, H / 2);
        await page.waitForFunction(() => document.getElementById('left').getBoundingClientRect().right <= 0.5, { timeout: 3000 }).catch(() => {});
        check((await rect('#left')).r <= 0.5, tag('tapping beside the drawer closes it'));
        // ---- more menu: quality, update, help
        await tapSel('#btnMore');
        const more = await rect('#topExtra');
        const items = await ev(() => ['quality', 'btnUpdate', 'btnHelp'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.left >= 0; }));
        check(inside(more) && items.every(Boolean), tag('⋮ menu shows quality, update and help inside the screen'), JSON.stringify(more));
        await shot('3-more');
        await tapSel('#btnHelp'); await wait(150);
        const help = await rect('#help .modal-body');
        check(inside(help) && !(await rect('#topExtra')).shown, tag('help opens fitted to the screen and closes the menu'), JSON.stringify(help));
        const touchRows = await ev(() => getComputedStyle(document.querySelector('#help tbody.touch-only')).display);
        check(touchRows === 'table-row-group', tag('help shows the touch gestures'), touchRows);
        await shot('4-help');
        await tapSel('#btnHelpClose');
      }

      // ---- touch on the model: find a point well inside a planar face of some part
      // like a user, zoom in a bit so a face is big enough to touch
      const frame = async () => {
        await ev(() => { const sv = window.__sv, t = sv.active; sv.setView(t, 'iso', false); t.camera.position.sub(t.target).multiplyScalar(0.6).add(t.target); t.camera.updateMatrixWorld(); sv.controls.update(); });
        await wait(250);
      };
      await frame();
      const target = await ev(() => {
        const sv = window.__sv, c = document.getElementById('canvas').getBoundingClientRect();
        const at = (x, y) => { const h = sv.pick({ clientX: x, clientY: y }); if (!h || h.cap) return null; const ff = h.part.faceFirst, fl = h.part.faceLast; for (let i = 0; i < ff.length; i++) if (h.tri >= ff[i] && h.tri <= fl[i]) return { part: h.part.id, f: i }; return null; };
        for (let y = 0.15; y <= 0.55; y += 0.02) for (let x = 0.2; x <= 0.8; x += 0.02) {
          const X = c.left + c.width * x, Y = c.top + c.height * y, a = at(X, Y);
          if (!a || !sv.faceData(sv.active.parts.find((p) => p.id === a.part), a.f).planar) continue;
          if ([[22, 0], [-22, 0], [0, 22], [0, -22], [16, 16], [-16, -16], [16, -16], [-16, 16]].every(([dx, dy]) => { const b = at(X + dx, Y + dy); return b && b.part === a.part && b.f === a.f; })) return { x: X, y: Y };
        }
        return null;
      });
      check(!!target, tag('found a face to touch'));
      if (target) {
        await ev(() => window.__sv.selectParts([]));
        await tap(target.x, target.y);
        check((await ev(() => window.__sv.active.selection.size)) === 1, tag('tap selects the part'));
        await tap(target.x, target.y);
        const ent = await ev(() => (window.__sv.active.entities || []).map((e) => e.kind));
        const sheet = await rect('#entityPanel'), bar = await rect('#toolbar');
        check(ent.length === 1 && ent[0] === 'face' && inside(sheet) && !overlap(sheet, bar), tag('second tap picks the face; its sheet fits above the toolbar'), JSON.stringify({ ent, sheet: sheet && [Math.round(sheet.y), Math.round(sheet.b)], bar: bar && Math.round(bar.y) }));
        await shot('5-picked');
        if (compact) {
          await tapSel('#entityPanel .panel-head > span');
          const folded = await rect('#entityPanel');
          const bodyShown = await ev(() => getComputedStyle(document.getElementById('entityBody')).display !== 'none');
          await tapSel('#entityPanel .panel-head > span');
          const unfolded = await rect('#entityPanel');
          check(folded.h < 60 && !bodyShown && unfolded.h > folded.h, tag('tapping the sheet title folds and unfolds it'), `${Math.round(folded.h)} / ${Math.round(unfolded.h)} px`);
          // the same from a keyboard: a focusable button with its state
          const kb = await ev(() => { const t = document.querySelector('#entityPanel .panel-head > span'); t.focus(); return { role: t.getAttribute('role'), tab: t.tabIndex, exp: t.getAttribute('aria-expanded'), focused: document.activeElement === t }; });
          await page.keyboard.press('Enter'); await wait(80);
          const kb2 = await ev(() => ({ exp: document.querySelector('#entityPanel .panel-head > span').getAttribute('aria-expanded'), folded: document.getElementById('entityPanel').classList.contains('collapsed') }));
          await page.keyboard.press(' '); await wait(80);
          const kb3 = await ev(() => document.getElementById('entityPanel').classList.contains('collapsed'));
          check(kb.role === 'button' && kb.tab === 0 && kb.focused && kb.exp === 'true' && kb2.exp === 'false' && kb2.folded && !kb3, tag('sheet title works from a keyboard (Enter / Space, aria-expanded)'), JSON.stringify({ kb, kb2, kb3 }));
        }
        // one-finger drag rotates and never taps
        const cam0 = await ev(() => window.__sv.active.camera.position.toArray());
        await touch('touchStart', [[target.x, target.y]]);
        for (let k = 1; k <= 8; k++) { await touch('touchMove', [[target.x + k * 12, target.y + k * 4]]); await wait(16); }
        await touch('touchEnd', []); await wait(250);
        const afterDrag = await ev(() => ({ cam: window.__sv.active.camera.position.toArray(), sel: window.__sv.active.selection.size, ents: window.__sv.active.entities.length }));
        check(afterDrag.cam.some((v, i) => Math.abs(v - cam0[i]) > 1e-6) && afterDrag.sel === 1 && afterDrag.ents === 1, tag('one-finger drag rotates without selecting'), JSON.stringify({ sel: afterDrag.sel, ents: afterDrag.ents }));
        // two-finger pinch zooms and never taps
        await ev(() => window.__sv.setView(window.__sv.active, 'iso', false)); await wait(200);
        const z0 = await ev(() => { const t = window.__sv.active; return t.camera.position.distanceTo(t.target) / t.camera.zoom; });
        const cx = W / 2, cy = H / 2;
        if (process.env.SV_DEBUG) console.log('   under pinch:', await ev(([x, y]) => [x - 80, x, x + 80].map((X) => { const e = document.elementFromPoint(X, y); return e && (e.id || e.className); }).join(' | '), [cx, cy]));
        await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
        for (let k = 1; k <= 8; k++) { await touch('touchMove', [[cx - 30 - k * 10, cy], [cx + 30 + k * 10, cy]]); await wait(16); }
        await touch('touchEnd', []); await wait(250);
        const afterPinch = await ev(() => { const t = window.__sv.active; return { z: t.camera.position.distanceTo(t.target) / t.camera.zoom, sel: t.selection.size, ents: t.entities.length }; });
        check(afterPinch.z < z0 * 0.95 && afterPinch.sel === 1 && afterPinch.ents === 1, tag('pinch zooms in without selecting'), `${z0.toFixed(2)} -> ${afterPinch.z.toFixed(2)}`);
        // long press = right click: menu inside the screen, rotation center from it
        await frame();
        await touch('touchStart', [[target.x, target.y]]); await wait(750); await touch('touchEnd', []); await wait(150);
        const menu = await rect('#ctxMenu');
        const items = await ev(() => Object.fromEntries([...document.querySelectorAll('#ctxMenu button')].map((b) => [b.dataset.act, !b.disabled])));
        check(inside(menu) && items.pivot && items.normalView && items.exportDxf, tag('long press opens the menu inside the screen'), JSON.stringify({ menu: menu && [Math.round(menu.x), Math.round(menu.y), Math.round(menu.r), Math.round(menu.b)], items }));
        await shot('6-menu');
        const t0 = await ev(() => window.__sv.active.target.toArray());
        await tapSel('#ctxMenu [data-act="pivot"]'); await wait(450);
        const t1 = await ev(() => window.__sv.active.target.toArray());
        check(t1.some((v, i) => Math.abs(v - t0[i]) > 1e-6) && !(await rect('#ctxMenu')).shown, tag('menu "rotation center" moves the pivot to the pressed point'));
        // a menu opened elsewhere (the tree) has no model point: the item is off, never an old point
        await ev(() => { const row = document.querySelector('#tree .tnode'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 120 })); });
        await wait(100);
        const treePivot = await ev(() => ({ open: !document.getElementById('ctxMenu').classList.contains('hidden'), pivot: !document.querySelector('#ctxMenu [data-act="pivot"]').disabled }));
        await ev(() => document.getElementById('ctxMenu').classList.add('hidden'));
        check(treePivot.open && !treePivot.pivot, tag('tree menu offers no stale rotation center'), JSON.stringify(treePivot));
        // DXF dialog fits
        await ev(() => { const sv = window.__sv; sv.openDxfDialog(sv.active, sv.actionFace(sv.active)); });
        await wait(200);
        const dxf = await rect('#dxfDlg .modal-body');
        const fontPx = await ev(() => parseFloat(getComputedStyle(document.getElementById('dxfName')).fontSize));
        check(inside(dxf) && (!compact || fontPx >= 16), tag('DXF dialog fits the screen (inputs ≥ 16 px on phones)'), `${JSON.stringify(dxf && [Math.round(dxf.x), Math.round(dxf.y), Math.round(dxf.r), Math.round(dxf.b)])} font ${fontPx}`);
        await shot('7-dxf');
        await tapSel('#btnDxfClose');
        await ev(() => window.__sv.setEntities(window.__sv.active, []));
      }
      // ---- section panel
      await tapSel('#btnSection'); await wait(150);
      const sec = await rect('#sectionPanel'), bar2 = await rect('#toolbar');
      check(inside(sec) && !overlap(sec, bar2), tag('section panel fits and leaves the toolbar free'), JSON.stringify(sec && [Math.round(sec.y), Math.round(sec.b)]));
      const secOut = await ev(() => { const p = document.getElementById('sectionPanel'), pr = p.getBoundingClientRect();
        return { inner: p.scrollWidth - p.clientWidth, out: [...p.querySelectorAll('input, button, label')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > pr.right + 0.5 || r.left < pr.left - 0.5); }).map((e) => e.className || e.tagName) }; });
      check(secOut.inner <= 1 && !secOut.out.length, tag('every section control stays inside the panel'), JSON.stringify(secOut));
      await shot('8-section');
      await tapSel('#btnSection');
      check(errors.length === 0, tag('no console errors'), errors.slice(0, 3).join(' | '));
      await page.close();
    }
  } catch (e) {
    check(false, 'exception', String(e && e.stack || e));
  } finally {
    await browser.close();
    srv.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
