// MCP server test: `node server.js --mcp` spoken to over stdio (JSON-RPC lines), driving a headless viewer window.
// usage: node scripts/mcptest.js [robot.urdf]   (an extra URDF is opened and posed too)
//        MCP_EXE=dist/StepViewer.exe node scripts/mcptest.js   (test the packaged exe's --mcp)
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 48700 + Math.floor(Math.random() * 100);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, m, d = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${d ? '  ' + d : ''}`); };

// a small robot: base box, an arm on a revolute joint (±90°), a slider (0..50 mm) and a finger mimicking the arm
function makeRobot(dir) {
  const f = path.join(dir, 'mcp_bot.urdf');
  fs.writeFileSync(f, `<robot name="mcp_bot">
  <link name="base"><visual><geometry><box size="0.1 0.1 0.02"/></geometry></visual></link>
  <link name="arm"><visual><origin xyz="0.05 0 0"/><geometry><box size="0.1 0.02 0.02"/></geometry></visual></link>
  <link name="slide"><visual><geometry><box size="0.02 0.02 0.02"/></geometry></visual></link>
  <link name="finger"><visual><origin xyz="0.02 0 0"/><geometry><box size="0.04 0.01 0.01"/></geometry></visual></link>
  <joint name="shoulder" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 0.02"/><axis xyz="0 0 1"/><limit lower="-1.5708" upper="1.5708"/></joint>
  <joint name="slider" type="prismatic"><parent link="base"/><child link="slide"/><origin xyz="0 0.03 0.02"/><axis xyz="1 0 0"/><limit lower="0" upper="0.05"/></joint>
  <joint name="tip" type="revolute"><parent link="arm"/><child link="finger"/><origin xyz="0.1 0 0"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/><mimic joint="shoulder" multiplier="0.5"/></joint>
</robot>`);
  return f;
}

function rawPost(p, headers, port = PORT, method = 'POST') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(method === 'POST' ? '{"cmd":"status"}' : undefined);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-mcp-'));
  const robot = makeRobot(tmp);
  const real = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const env = { ...process.env, STEPVIEWER_NO_BROWSER: '1', STEPVIEWER_KEEPALIVE: '1' };
  let srv = null, mcp = null, browser = null;
  try {
    srv = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], { env, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/hello`); break; } catch { await wait(150); } }
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: fs.mkdtempSync(path.join(tmp, 'prof-')),
      args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sv);

    // ---- the MCP server process
    // MCP_EXE=dist/StepViewer.exe: the packaged exe (GUI subsystem) as the MCP server
    const exe = process.env.MCP_EXE ? path.resolve(process.env.MCP_EXE) : null;
    mcp = spawn(exe || process.execPath, exe ? ['--mcp'] : [path.join(root, 'server.js'), '--mcp'], { env: { ...env, STEPVIEWER_MCP_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', stray = '';
    const waiting = new Map();
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', (c) => {
      out += c;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { stray += line + '\n'; continue; }
        if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      }
    });
    mcp.stderr.resume();
    let seq = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`${method}: no answer`)), 180000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const tool = async (name, args = {}) => {
      const m = await rpc('tools/call', { name, arguments: args });
      if (m.error) return { isError: true, rpcError: m.error, data: null, content: [] }; // protocol error (unknown tool, bad arguments)
      const r = m.result;
      const text = r.content.find((c) => c.type === 'text');
      return { isError: !!r.isError, data: text ? (() => { try { return JSON.parse(text.text); } catch { return text.text; } })() : null, content: r.content };
    };

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcptest', version: '1' } });
    check(init.result && init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools && init.result.serverInfo.name === 'stepviewer', 'initialize', JSON.stringify(init.result && init.result.serverInfo));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    check(names.length >= 11 && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.description), 'tools/list', names.join(','));
    const unknown = await rpc('nope/method', {});
    check(unknown.error && unknown.error.code === -32601, 'unknown method -> -32601');
    // malformed messages get an error answer instead of being dropped
    const bad = await new Promise((resolve) => { waiting.set(null, resolve); mcp.stdin.write('null' + String.fromCharCode(10)); });
    check(bad.error && bad.error.code === -32600 && bad.id === null, 'a malformed message -> -32600', JSON.stringify(bad));
    const badArgs = await rpc('tools/call', { name: 'manage_tab', arguments: { tab: '#0', action: 'delete' } });
    check(badArgs.error && badArgs.error.code === -32602 && /action/.test(badArgs.error.message), 'arguments are checked against the schema (enum)', JSON.stringify(badArgs.error));
    const typo = await rpc('tools/call', { name: 'set_joints', arguments: { value: { a: 1 } } });
    check(typo.error && typo.error.code === -32602 && /not a known argument/.test(typo.error.message), 'an unknown argument is refused', JSON.stringify(typo.error));
    const inherited = await rpc('tools/call', { name: 'viewer_status', arguments: { constructor: true } });
    check(inherited.error && inherited.error.code === -32602, 'an inherited name (constructor) is not an argument', JSON.stringify(inherited.error));
    // raw lines: invalid requests get -32600 (id null when it cannot be read), notifications get nothing
    // (an invalid request with a readable id, 7, is answered under that id)
    const rawLine = (line, ms = 1500) => new Promise((resolve) => {
      const done = (m) => { clearTimeout(t); waiting.delete(null); waiting.delete(7); resolve(m); };
      const t = setTimeout(() => done(null), ms);
      waiting.set(null, done); waiting.set(7, done);
      mcp.stdin.write(line + String.fromCharCode(10));
    });
    const invalids = [];
    for (const line of ['[]', '{}', '{"jsonrpc":"1.0","id":7,"method":"ping"}', '{"jsonrpc":"2.0","id":true,"method":"ping"}',
      '{"jsonrpc":"2.0","id":7,"method":"ping","params":[]}', '{"jsonrpc":"2.0","id":7,"method":"ping","result":{}}', '{"jsonrpc":"2.0","id":7,"result":{},"error":{"code":1,"message":"x"}}']) {
      const ans = await rawLine(line);
      invalids.push([line, ans && ans.error && ans.error.code]);
    }
    check(invalids.every((x) => x[1] === -32600), 'invalid JSON-RPC messages -> -32600', JSON.stringify(invalids));
    const note = await rawLine('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"viewer_status"}}', 1500);
    check(note === null, 'a tools/call without id (notification) gets no answer');

    let r = await tool('viewer_status');
    check(!r.isError && Array.isArray(r.data.tabs) && r.data.tabs.length === 0, 'viewer_status with no tabs', JSON.stringify(r.data));

    r = await tool('open_files', { paths: [robot, 'relative/x.step', path.join(tmp, 'none.step'), path.join(tmp, 'a.txt')] });
    check(!r.isError && r.data.opened.length === 1 && r.data.opened[0].robot && r.data.opened[0].robot.joints === 3 && r.data.rejected.length === 3,
      'open_files opens the URDF and reports rejected paths', JSON.stringify({ opened: r.data.opened, rejected: r.data.rejected }));
    r = await tool('open_files', { paths: ['C:\\nowhere\\x.step'] });
    check(r.isError, 'open_files with nothing openable is an error', JSON.stringify(r.data));

    r = await tool('get_joints');
    const sh = r.data.joints.find((j) => j.name === 'shoulder'), sl = r.data.joints.find((j) => j.name === 'slider'), tip = r.data.joints.find((j) => j.name === 'tip');
    check(sh && sh.unit === 'deg' && Math.abs(sh.limits[1] - 90) < 0.01 && sl.unit === 'mm' && sl.limits[1] === 50 && tip.mimic && tip.mimic.joint === 'shoulder',
      'get_joints: units, limits (deg / mm), mimic', JSON.stringify(r.data.joints.map((j) => [j.name, j.unit, j.limits, j.mimic && j.mimic.joint])));

    r = await tool('set_joints', { values: { shoulder: 60, slider: 80 } });
    const v = Object.fromEntries(r.data.joints.map((j) => [j.name, j.value]));
    check(!r.isError && v.shoulder === 60 && v.slider === 50 && v.tip === 30 && r.data.clamped.length === 1 && r.data.clamped[0].joint === 'slider',
      'set_joints: moved, mimic follows, out-of-range value clamped', JSON.stringify({ v, clamped: r.data.clamped }));
    // the pose really changed: the arm's far end at 60° (link frame: x 0..100 mm)
    r = await tool('get_model', { filter: 'arm' });
    const arm = r.data.parts[0];
    check(arm && Math.abs(arm.box_mm.max[1] - (Math.sin(Math.PI / 3) * 100 + Math.cos(Math.PI / 3) * 10)) < 0.5, 'get_model: the moved link box follows the pose', JSON.stringify(arm && arm.box_mm));
    const ui = await page.evaluate(() => document.querySelector('#jointList .jrow[data-j="shoulder"] .jnum').value);
    check(ui === '60.0', 'the joint panel shows the value set over MCP', ui);
    r = await tool('set_joints', { values: { tip: 10 } });
    check(r.isError && /mimic/.test(JSON.stringify(r.data)), 'a mimic joint cannot be set');
    r = await tool('set_joints', { values: { shoulder: 'x' } });
    check(r.isError && r.rpcError && r.rpcError.code === -32602, 'a non-number value is an error');
    r = await tool('set_joints', { values: { slider: 80, shoulder: 270 }, ignore_limits: true });
    check(!r.isError && r.data.joints.find((j) => j.name === 'slider').value === 80 && r.data.joints.find((j) => j.name === 'shoulder').value === 270 && !r.data.clamped.length,
      'ignore_limits takes any value (past the UI slider range too)', JSON.stringify(r.data.joints.map((j) => [j.name, j.value])));
    r = await tool('set_joints', { reset: true, ignore_limits: false });
    check(!r.isError && r.data.joints.every((j) => j.value === j.home), 'reset returns to home', JSON.stringify(r.data.joints.map((j) => [j.name, j.value])));

    r = await tool('set_visibility', { action: 'only', parts: ['arm'] });
    check(!r.isError && r.data.visible === 1, 'set_visibility only', JSON.stringify(r.data));
    r = await tool('set_visibility', { action: 'all' });
    check(!r.isError && r.data.visible === r.data.parts, 'set_visibility all');
    r = await tool('set_visibility', { action: 'hide', parts: ['nope'] });
    check(r.isError, 'unknown part name is an error');
    r = await tool('select_parts', { parts: ['slide'] });
    check(!r.isError && r.data.selected.length === 1, 'select_parts', JSON.stringify(r.data));
    await tool('select_parts', { parts: [] });
    r = await tool('set_view', { view: 'top' });
    const up = await page.evaluate(() => window.__sv.active.camera.position.z > window.__sv.active.target.z);
    check(!r.isError && up, 'set_view top looks down');
    r = await tool('set_section', { axis: 'x', position_mm: 10 });
    const caps = await page.evaluate(() => window.__sv.active.clipPlanes.length);
    check(!r.isError && r.data.x.on && r.data.x.position_mm === 10 && caps === 1, 'set_section x at 10 mm', JSON.stringify(r.data.x));
    r = await tool('screenshot', { max_size: 400 });
    const img = r.content.find((c) => c.type === 'image');
    const png = img && Buffer.from(img.data, 'base64');
    check(!r.isError && img && img.mimeType === 'image/png' && png.slice(1, 4).toString() === 'PNG' && Math.max(r.data.width, r.data.height) === 400, 'screenshot returns a PNG', JSON.stringify(r.data));
    if (img) fs.writeFileSync(path.join(tmp, 'shot.png'), png);
    r = await tool('set_section', { axis: 'off' });
    check(!r.isError && !r.data.x.on && (await page.evaluate(() => window.__sv.active.clipPlanes.length)) === 0, 'set_section off');

    if (real) {
      const t0 = Date.now();
      r = await tool('open_files', { paths: [real] });
      check(!r.isError && r.data.opened.length === 1 && !r.data.opened[0].missing.length, `${path.basename(real)} opened over MCP`, `${Date.now() - t0} ms ${JSON.stringify(r.data.opened.map((t) => [t.name, t.parts, t.robot]))}`);
      r = await tool('get_joints');
      const free = r.data.joints.filter((j) => !j.mimic);
      const vals = Object.fromEntries(free.map((j) => [j.name, (j.range[0] + j.range[1]) / 2]));
      r = await tool('set_joints', { values: vals });
      check(!r.isError && !r.data.clamped.length, 'every joint moved to the middle of its range', JSON.stringify(vals));
      await tool('set_view', { view: 'iso' });
      r = await tool('screenshot', { max_size: 900 });
      const im = r.content.find((c) => c.type === 'image');
      if (im) fs.writeFileSync(path.join(tmp, 'real.png'), Buffer.from(im.data, 'base64'));
      check(!r.isError && !!im, 'screenshot of the real robot', path.join(tmp, 'real.png'));
    }

    // cancelled while the window is loading: its loading tab is closed, the request gets no answer
    {
      const big = path.join(tmp, 'big.stl'), N = 600000; // a binary STL big enough to still be loading when cancelled
      const b = Buffer.alloc(84 + N * 50);
      b.writeUInt32LE(N, 80);
      for (let i = 0; i < N; i++) {
        const o = 84 + i * 50 + 12, x = (i % 1000) * 0.01, y = Math.floor(i / 1000) * 0.01;
        b.writeFloatLE(x, o); b.writeFloatLE(y, o + 4); b.writeFloatLE(0, o + 8);
        b.writeFloatLE(x + 0.01, o + 12); b.writeFloatLE(y, o + 16); b.writeFloatLE(0, o + 20);
        b.writeFloatLE(x, o + 24); b.writeFloatLE(y + 0.01, o + 28); b.writeFloatLE(0, o + 32);
      }
      fs.writeFileSync(big, b);
      const n0 = await page.evaluate(() => window.__sv.tabs.length);
      const answered = [];
      const prev = waiting.get('big-1');
      waiting.set('big-1', (m) => answered.push(m));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'big-1', method: 'tools/call', params: { name: 'open_files', arguments: { paths: [big] } } }) + String.fromCharCode(10));
      let sawLoading = false;
      for (let i = 0; i < 100 && !sawLoading; i++) { await wait(30); sawLoading = await page.evaluate(() => window.__sv.tabs.some((t) => t.loading && t.name === 'big.stl')); }
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'big-1' } }) + String.fromCharCode(10));
      await wait(3000);
      const after = await page.evaluate(() => window.__sv.tabs.map((t) => t.name));
      check(sawLoading && after.length === n0 && !after.includes('big.stl') && !answered.length, 'cancelled while loading in the window: its tab is closed, no answer',
        JSON.stringify({ sawLoading, after, answered: answered.length }));
      waiting.delete('big-1'); if (prev) waiting.set('big-1', prev);
    }
    // cancelled while the result is on its way (result POST held back): the opened tab is closed again
    {
      let hold = true;
      await page.setRequestInterception(true);
      const onReq = (req) => { if (hold && req.url().endsWith('/api/rpc/result')) setTimeout(() => req.continue().catch(() => {}), 2000); else req.continue().catch(() => {}); };
      page.on('request', onReq);
      const n0 = await page.evaluate(() => window.__sv.tabs.length);
      const answered = [];
      waiting.set('late-1', (m) => answered.push(m));
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'late-1', method: 'tools/call', params: { name: 'open_files', arguments: { paths: [robot] } } }) + String.fromCharCode(10));
      let loaded = false;
      for (let i = 0; i < 100 && !loaded; i++) { await wait(30); loaded = await page.evaluate((k) => window.__sv.tabs.length > k && !window.__sv.tabs.some((t) => t.loading), n0); }
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'late-1' } }) + String.fromCharCode(10));
      await wait(3500);
      const n1 = await page.evaluate(() => window.__sv.tabs.length);
      check(loaded && n1 === n0 && !answered.length, 'cancelled while the result is on its way: the opened tab is closed again', JSON.stringify({ loaded, n0, n1, answered: answered.length }));
      hold = false;
      page.off('request', onReq);
      await page.setRequestInterception(false);
      waiting.delete('late-1');
    }

    r = await tool('viewer_status');
    const n = r.data.tabs.length;
    r = await tool('manage_tab', { tab: '#0', action: 'close' });
    check(!r.isError && r.data.tabs.length === n - 1, 'manage_tab close by index');
    r = await tool('manage_tab', { tab: 'nope.step', action: 'activate' });
    check(r.isError, 'unknown tab is an error');
    r = await tool('nope_tool');
    check(r.rpcError && r.rpcError.code === -32602, 'unknown tool is a protocol error');

    // the bridge refuses requests without the app header or with a foreign Host (DNS rebinding)
    check((await rawPost('/api/rpc', {})) === 403, '/api/rpc needs the app header');
    check((await rawPost('/api/rpc', { 'X-StepViewer': '1', Host: 'evil.example:' + PORT })) === 403, '/api/rpc refuses a foreign Host');
    check((await rawPost('/api/rpc/result', {})) === 403, '/api/rpc/result needs the app header');
    // every route checks the Host: a rebinding page can neither join the event stream nor read files
    check((await rawPost('/api/events', { Host: 'evil.example:' + PORT }, PORT, 'GET')) === 403 && (await rawPost('/', { Host: 'evil.example' }, PORT, 'GET')) === 403,
      'event stream and pages refuse a foreign Host');

    // a command whose caller gave up while no window was open is not run when one connects later
    {
      const P2 = PORT + 1;
      const srv2 = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${P2}`], { env, stdio: 'ignore' });
      try {
        for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${P2}/api/hello`); break; } catch { await wait(150); } }
        const ac = new AbortController();
        const pr = fetch(`http://127.0.0.1:${P2}/api/rpc`, { method: 'POST', signal: ac.signal, headers: { 'X-StepViewer': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd: 'open', args: { paths: [robot] } }) }).catch(() => null);
        await wait(800);
        ac.abort();
        await pr;
        await wait(300);
        const p2 = await browser.newPage();
        await p2.goto(`http://127.0.0.1:${P2}/`, { waitUntil: 'load' });
        await p2.waitForFunction(() => window.__sv);
        await wait(2000);
        let n2 = await p2.evaluate(() => window.__sv.tabs.length);
        check(n2 === 0, 'a cancelled command is dropped', String(n2));
        await p2.close();
        // the same through MCP: notifications/cancelled aborts the request (and it gets no answer)
        const m2 = spawn(process.execPath, [path.join(root, 'server.js'), '--mcp'], { env: { ...env, STEPVIEWER_MCP_PORT: String(P2) }, stdio: ['pipe', 'pipe', 'ignore'] });
        let o2 = '';
        m2.stdout.setEncoding('utf8');
        m2.stdout.on('data', (c) => { o2 += c; });
        const w2 = (x) => m2.stdin.write(JSON.stringify(x) + String.fromCharCode(10));
        w2({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        w2({ jsonrpc: '2.0', method: 'notifications/initialized' });
        w2({ jsonrpc: '2.0', id: 'open-1', method: 'tools/call', params: { name: 'open_files', arguments: { paths: [robot] } } });
        await wait(1000);
        w2({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'open-1', reason: 'test' } });
        await wait(500);
        const p3 = await browser.newPage();
        await p3.goto(`http://127.0.0.1:${P2}/`, { waitUntil: 'load' });
        await p3.waitForFunction(() => window.__sv);
        await wait(2000);
        n2 = await p3.evaluate(() => window.__sv.tabs.length);
        m2.kill();
        check(n2 === 0 && !/"open-1"/.test(o2), 'an MCP request cancelled with notifications/cancelled is not run and gets no answer', JSON.stringify({ tabs: n2, out: o2.slice(0, 300) }));
        await p3.close();
      } finally { srv2.kill(); }
    }

    check(stray === '', 'nothing but protocol messages on stdout', stray.slice(0, 200));
    check(!pageErrors.length, 'no page errors', pageErrors.join(' | '));
    console.log(`      screenshots in ${tmp}`);
  } catch (e) {
    fails++;
    console.log('FAIL  ' + (e && e.stack || e));
  } finally {
    if (mcp) mcp.kill();
    if (browser) await browser.close();
    if (srv) srv.kill();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
