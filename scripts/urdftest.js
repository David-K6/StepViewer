// Headless test of URDF robots: loading (desktop sibling lookup and web-style multi-file open), forward kinematics
// against an independent computation, joint panel (sliders, numbers, limits, mimic, reset), and that geometry,
// CAD edges, bounds and BVH follow a moved link (picking, sections).
// usage: node scripts/urdftest.js [robot.urdf]   (a synthetic robot is always tested; a given URDF is tested too)
//   env SV_SHOTS=<dir>  -> save screenshots there
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require('puppeteer-core');
const URDF = require('../app/urdffile.js');

const root = path.join(__dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 48100 + Math.floor(Math.random() * 50);
const SHOTS = process.env.SV_SHOTS || null;
const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- synthetic robot in the ROS layout: <pkg>/urdf/bot.urdf, <pkg>/meshes/*
function binaryStl(tris) {
  const b = Buffer.alloc(84 + tris.length * 50);
  b.write('synthetic', 0);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => { const o = 84 + i * 50; t.flat().forEach((v, k) => b.writeFloatLE(v, o + 12 + k * 4)); });
  return b;
}
/** closed box soup in meters (12 triangles, outward winding) */
function boxTris(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const c = (i, j, k) => [ox + (i * sx) / 2, oy + (j * sy) / 2, oz + (k * sz) / 2];
  const q = (a, b, cc, d) => [[a, b, cc], [a, cc, d]];
  return [...q(c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)), ...q(c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)),
    ...q(c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)), ...q(c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)),
    ...q(c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)), ...q(c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1))];
}
function makeRobot(dir) {
  const pkg = path.join(dir, 'bot_description');
  fs.mkdirSync(path.join(pkg, 'urdf'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'meshes'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'meshes', 'arm.stl'), binaryStl(boxTris(0.2, 0.04, 0.04, 0.1, 0, 0))); // 200 mm bar along +X
  // ASCII STL in millimeters (scale 0.001 in the URDF)
  const t = boxTris(30, 30, 60, 0, 0, 30);
  fs.writeFileSync(path.join(pkg, 'meshes', 'tool.stl'), `solid tool\n${t.map((f) => ` facet normal 0 0 0\n  outer loop\n${f.map((v) => `   vertex ${v.join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n')}\nendsolid tool\n`);
  const o = boxTris(0.02, 0.02, 0.02);
  const ov = o.flat(), objV = [], objF = [];
  for (let i = 0; i < ov.length; i++) objV.push(`v ${ov[i].join(' ')}`);
  for (let i = 0; i < o.length; i++) objF.push(`f ${i * 3 + 1} ${i * 3 + 2} ${i * 3 + 3}`);
  fs.writeFileSync(path.join(pkg, 'meshes', 'finger.obj'), objV.join('\n') + '\n' + objF.join('\n') + '\n');
  // decoy with the same name below the URDF's folder: package:// must take the package's own mesh
  fs.mkdirSync(path.join(pkg, 'urdf', 'meshes'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'urdf', 'meshes', 'arm.stl'), binaryStl(boxTris(0.01, 0.01, 0.01)));
  // "../geometry/plate.obj": one concave (L-shaped) polygon, 3 cm² (z = 0)
  fs.mkdirSync(path.join(pkg, 'geometry'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'geometry', 'plate.obj'), '# plate\nv 0 0 0\nv\t0.02 0 0\nv 0.02 0.01 0 # corner\nv 0.01 0.01 0\nv 0.01 0.02 0\nv 0 0.02 0\nf 1 2\t3 4 5 6 # L shape\n');
  const urdf = `<?xml version="1.0"?>
<robot name="bot">
  <material name="blue"><color rgba="0.1 0.3 0.9 1"/></material>
  <link name="base"><visual><origin xyz="0 0 0.025"/><geometry><box size="0.3 0.3 0.05"/></geometry><material name="blue"/></visual></link>
  <link name="turret"><visual><origin xyz="0 0 0.05"/><geometry><cylinder radius="0.05" length="0.1"/></geometry></visual></link>
  <link name="arm"><visual><geometry><mesh filename="package://bot_description/meshes/arm.stl"/></geometry><material name="red"><color rgba="0.9 0.2 0.2 1"/></material></visual></link>
  <link name="slider"><visual><geometry><mesh filename="package://bot_description/meshes/tool.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>
  <link name="finger_l"><visual><geometry><mesh filename="../meshes/finger.obj"/></geometry></visual></link>
  <link name="finger_r"><visual><geometry><mesh filename="finger.obj"/></geometry></visual></link>
  <link name="ball"><visual><geometry><sphere radius="0.015"/></geometry><material name="ghost"><color rgba="1 1 1 0.5"/></material></visual></link>
  <link name="plate"><visual><geometry><mesh filename="../geometry/plate.obj"/></geometry></visual></link>
  <link name="finger_r2"/>
  <link name="lost"><visual><geometry><mesh filename="package://bot_description/meshes/missing.stl"/></geometry></visual></link>
  <link name="tip"/>
  <joint name="spin" type="continuous"><parent link="base"/><child link="turret"/><origin xyz="0 0 0.05"/><axis xyz="0 0 1"/></joint>
  <joint name="shoulder" type="revolute"><parent link="turret"/><child link="arm"/><origin xyz="0 0 0.1" rpy="0.1 -0.2 0.3"/><axis xyz="0 1 0"/>
    <limit lower="-1.0" upper="1.5" effort="1" velocity="1"/></joint>
  <joint name="extend" type="prismatic"><parent link="arm"/><child link="slider"/><origin xyz="0.2 0 0" rpy="0 1.5707963 0"/><axis xyz="0 0 1"/>
    <limit lower="0" upper="0.05" effort="1" velocity="1"/></joint>
  <joint name="grip_l" type="revolute"><parent link="slider"/><child link="finger_l"/><origin xyz="0.01 0 0.06"/><axis xyz="1 1 0"/>
    <limit lower="-0.5" upper="0.5" effort="1" velocity="1"/></joint>
  <joint name="grip_r" type="revolute"><parent link="slider"/><child link="finger_r"/><origin xyz="-0.01 0 0.06"/><axis xyz="1 1 0"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/><mimic joint="grip_l" multiplier="-2" offset="0.1"/></joint>
  <joint name="ball_fix" type="fixed"><parent link="finger_l"/><child link="ball"/><origin xyz="0 0 0.02"/></joint>
  <joint name="lost_fix" type="fixed"><parent link="base"/><child link="lost"/></joint>
  <joint name="lock" type="prismatic"><parent link="base"/><child link="plate"/><origin xyz="0.1 0.1 0.05"/><axis xyz="0 0 1"/>
    <limit lower="0.025" upper="0.025" effort="1" velocity="1"/></joint>
  <joint name="grip_r2" type="revolute"><parent link="finger_r"/><child link="finger_r2"/><origin xyz="0 0 0.02"/><axis xyz="1 0 0"/>
    <limit lower="-3" upper="2.5" effort="1" velocity="1"/><mimic joint="grip_r" multiplier="3" offset="0.2"/></joint>
  <joint name="tip_fix" type="fixed"><parent link="ball"/><child link="tip"/><origin xyz="0 0 0.01"/></joint>
</robot>
`;
  const file = path.join(pkg, 'urdf', 'bot.urdf');
  fs.writeFileSync(file, urdf);
  // web-style open: all files picked together (flat)
  const flat = [file, ...['arm.stl', 'tool.stl', 'finger.obj'].map((f) => path.join(pkg, 'meshes', f)), path.join(pkg, 'geometry', 'plate.obj')];
  return { file, flat };
}

// ---- independent forward kinematics (plain arrays, row-major 3x3 + translation, meters)
function rpyMat([r, p, y]) {
  const Rx = [[1, 0, 0], [0, Math.cos(r), -Math.sin(r)], [0, Math.sin(r), Math.cos(r)]];
  const Ry = [[Math.cos(p), 0, Math.sin(p)], [0, 1, 0], [-Math.sin(p), 0, Math.cos(p)]];
  const Rz = [[Math.cos(y), -Math.sin(y), 0], [Math.sin(y), Math.cos(y), 0], [0, 0, 1]];
  return mm3(Rz, mm3(Ry, Rx));
}
function mm3(A, B) { return A.map((row, i) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j])); }
const mv3 = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function axisAngle(a, q) { // Rodrigues
  const [x, y, z] = a, c = Math.cos(q), s = Math.sin(q), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
}
function fk(text, values) { // -> link -> { R, t (mm) }
  const doc = URDF.parseXml(text), robot = doc.children.find((c) => c.tag === 'robot');
  const el = (e, tag) => e.children.find((c) => c.tag === tag);
  const nums = (s, d) => (s ? s.trim().split(/\s+/).map(Number) : d);
  const joints = robot.children.filter((c) => c.tag === 'joint').map((j) => ({
    name: j.attr.name, type: j.attr.type, parent: el(j, 'parent').attr.link, child: el(j, 'child').attr.link,
    xyz: nums(el(j, 'origin') && el(j, 'origin').attr.xyz, [0, 0, 0]), rpy: nums(el(j, 'origin') && el(j, 'origin').attr.rpy, [0, 0, 0]),
    axis: nums(el(j, 'axis') && el(j, 'axis').attr.xyz, [1, 0, 0]), mimic: el(j, 'mimic') ? el(j, 'mimic').attr : null,
  }));
  const val = (j) => (j.mimic ? val(joints.find((k) => k.name === j.mimic.joint)) * Number(j.mimic.multiplier ?? 1) + Number(j.mimic.offset ?? 0) : values[j.name] || 0);
  const W = { };
  const childOf = new Set(joints.map((j) => j.child));
  for (const l of robot.children.filter((c) => c.tag === 'link')) if (!childOf.has(l.attr.name)) W[l.attr.name] = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
  for (let guard = 0; guard < 50; guard++) {
    for (const j of joints) {
      if (!W[j.parent] || W[j.child]) continue;
      const P = W[j.parent];
      const Ro = rpyMat(j.rpy);
      let R = mm3(P.R, Ro);
      let t = P.t.map((x, i) => x + mv3(P.R, j.xyz.map((v) => v * 1000))[i]);
      const n = Math.hypot(...j.axis), a = j.axis.map((x) => x / n), q = val(j);
      if (j.type === 'revolute' || j.type === 'continuous') R = mm3(R, axisAngle(a, q));
      else if (j.type === 'prismatic') t = t.map((x, i) => x + mv3(R, a.map((v) => v * q * 1000))[i]);
      W[j.child] = { R, t };
    }
  }
  return W;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-urdf-'));
  const synth = makeRobot(tmp);
  const real = process.argv[2] ? path.resolve(process.argv[2]) : null;
  let srv = null, browser = null, profile = null;
  const errors = [];
  const post = (paths) => fetch(`http://127.0.0.1:${PORT}/api/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
  // files picked together (open dialog / MCP): same lookup, but references picked with an assembly/URDF get no tab
  const pick = (paths) => fetch(`http://127.0.0.1:${PORT}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StepViewer': '1' }, body: JSON.stringify({ cmd: 'open', args: { paths } }) });
  try {
    srv = spawn(process.execPath, [path.join(root, 'server.js'), `--port=${PORT}`], {
      env: { ...process.env, STEPVIEWER_NO_BROWSER: '1', STEPVIEWER_KEEPALIVE: '1' }, stdio: 'pipe' });
    await wait(600);
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-urdf-prof-'));
    browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', userDataDir: profile,
      args: ['--use-angle=d3d11', '--enable-webgl', '--ignore-gpu-blocklist', '--window-size=1500,950'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 950 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    const shot = async (n) => { if (!SHOTS) return; await wait(300); await page.screenshot({ path: path.join(SHOTS, `urdf-${n}.png`) }); };
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sv);
    const ev = (fn, ...a) => page.evaluate(fn, ...a);
    const frames = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const waitLoaded = (n) => page.waitForFunction((k) => window.__sv.tabs.length >= k && !window.__sv.tabs.some((t) => t.loading), { timeout: 300000 }, n);

    // ---------------- synthetic robot through the local server (package://, ../ and bare references)
    await post([synth.file]);
    await waitLoaded(1);
    let st = await ev(() => {
      const t = window.__sv.active, R = t.robot;
      return { parts: t.parts.map((p) => ({ name: p.name, link: p.link, faces: p.faceFirst.length, edges: p.edges.length / 6, opacity: p.opacity })), missing: t.missing,
        ui: R && R.ui.map((j) => j.name), btn: !document.getElementById('btnJoints').classList.contains('hidden'),
        panel: !document.getElementById('jointPanel').classList.contains('hidden'), rows: document.querySelectorAll('#jointList .jrow').length,
        tree: t.rootNode.name, toast: document.getElementById('toast').textContent,
        armX: (() => { const p = t.parts.find((x) => x.link === 'arm'), a = p.local.pos; let lo = Infinity, hi = -Infinity; for (let i = 0; i < a.length; i += 3) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return hi - lo; })(), // link frame
        plate: (() => { const p = t.parts.find((x) => x.link === 'plate'); return { faces: p.faceFirst.length, area: window.__sv.faceData(p, 0).area }; })(),
        lock: (() => { const r = document.querySelector('#jointList .jrow[data-j="lock"]'); return r && { num: r.querySelector('.jnum').value, min: r.querySelector('.jpos').min, max: r.querySelector('.jpos').max }; })() };
    });
    const links = st.parts.map((p) => p.link).sort().join(',');
    check(links === 'arm,ball,base,finger_l,finger_r,plate,slider,turret', 'synthetic robot: every visual loads (box, cylinder, sphere, binary/ASCII STL, OBJ; package://, ../, bare names)', links);
    check(Math.abs(st.armX - 200) < 1e-3, 'package:// takes the package mesh, not a same-named file below the URDF folder', `arm length ${st.armX} mm`);
    check(st.plate.faces === 1 && Math.abs(st.plate.area - 300) < 1e-3, '"../geometry/x.obj" resolves; a concave OBJ polygon is triangulated correctly', JSON.stringify(st.plate));
    check(st.lock && st.lock.num === '25.00' && Number(st.lock.min) === 25 && Number(st.lock.max) === 25, 'lower = upper keeps the joint locked at that value', JSON.stringify(st.lock));
    check(st.missing.length === 1 && st.missing[0] === 'missing.stl' && /메시 파일 1개를 찾지 못했습니다/.test(st.toast), 'a missing mesh is reported, the rest still opens', JSON.stringify(st.missing));
    check(st.parts.find((p) => p.link === 'base').faces === 6 && st.parts.find((p) => p.link === 'base').edges === 12, 'box becomes 6 faces with 12 CAD edges', JSON.stringify(st.parts.find((p) => p.link === 'base')));
    const cyl = st.parts.find((p) => p.link === 'turret');
    check(cyl.faces === 3, 'cylinder: side + two caps', JSON.stringify(cyl));
    check(Math.abs(st.parts.find((p) => p.link === 'ball').opacity - 0.5) < 1e-6, 'material alpha becomes part transparency');
    check(st.btn && st.panel && st.rows === 7 && st.ui.join(',') === 'spin,shoulder,extend,grip_l,grip_r,lock,grip_r2', 'joint button + panel shown, movable joints in URDF order', st.ui && st.ui.join(','));

    // the server hands out mesh files below the URDF's parent folder only
    fs.writeFileSync(path.join(tmp, 'secret.stl'), binaryStl(boxTris(1, 1, 1)));
    const sib = async (name) => (await fetch(`http://127.0.0.1:${PORT}/api/sibling/1?name=${encodeURIComponent(name)}`)).status;
    const codes = { up2: await sib('../../secret.stl'), pkg: await sib('package://bot_description/../../secret.stl'), abs: await sib(path.join(tmp, 'secret.stl')),
      notMesh: await sib('../urdf/bot.urdf'), ok: await sib('package://bot_description/meshes/arm.stl') };
    check(codes.up2 === 204 && codes.pkg === 204 && codes.abs === 204 && codes.notMesh === 204 && codes.ok === 200, 'server refuses files outside the package folder and non-mesh files', JSON.stringify(codes));
    const text = fs.readFileSync(synth.file, 'utf8');
    const compareFk = async (values, label) => {
      const got = await ev(() => { const R = window.__sv.active.robot; const o = {}; for (const [n, l] of R.links) o[n] = l.world.elements.slice(); return o; });
      const W = fk(text, { lock: 0.025, ...values });
      let worst = 0;
      for (const [n, w] of Object.entries(W)) {
        const e = got[n];
        if (!e) { worst = Infinity; continue; }
        for (let i = 0; i < 3; i++) {
          worst = Math.max(worst, Math.abs(e[12 + i] - w.t[i]) / 1000); // position (m-scale tolerance)
          for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(e[k * 4 + i] - w.R[i][k]));
        }
      }
      check(worst < 1e-6, `forward kinematics matches an independent computation (${label})`, `max err ${worst.toExponential(2)}`);
    };
    // home pose: 0 inside the limits (extend's 0 is its lower limit)
    await compareFk({}, 'home pose');
    // move with the sliders / number boxes like a user
    const setUi = (name, disp, how = 'range') => ev((n, v, h) => {
      const row = document.querySelector(`#jointList .jrow[data-j="${n}"]`);
      const el = row.querySelector(h === 'range' ? '.jpos' : '.jnum');
      el.value = String(v);
      el.dispatchEvent(new Event(h === 'range' ? 'input' : 'change', { bubbles: true }));
    }, name, disp, how);
    const armBefore = await ev(() => { const p = window.__sv.active.parts.find((x) => x.link === 'slider'); return { pos: Array.from(p.mesh.geometry.getAttribute('position').array.slice(0, 3)), box: p.box.min.toArray() }; });
    await setUi('spin', 200, 'num'); // continuous: any angle in the number box
    await setUi('shoulder', 40);
    await setUi('extend', 30); // mm
    await setUi('grip_l', 20);
    await frames();
    await compareFk({ spin: (200 * Math.PI) / 180, shoulder: (40 * Math.PI) / 180, extend: 0.03, grip_l: (20 * Math.PI) / 180 }, 'after slider moves, incl. mimic');
    st = await ev(() => {
      const t = window.__sv.active, R = t.robot, T = window.__sv.THREE;
      const out = {};
      // geometry, normals and CAD edges = link transform * link-frame copy
      let worst = 0;
      for (const p of t.parts) {
        const M = R.links.get(p.link).world;
        const pos = p.mesh.geometry.getAttribute('position').array, nrm = p.mesh.geometry.getAttribute('normal').array;
        for (let i = 0; i < pos.length; i += 3 * 7) {
          const v = new T.Vector3(p.local.pos[i], p.local.pos[i + 1], p.local.pos[i + 2]).applyMatrix4(M);
          worst = Math.max(worst, Math.abs(v.x - pos[i]), Math.abs(v.y - pos[i + 1]), Math.abs(v.z - pos[i + 2]));
          const n = new T.Vector3(p.local.nrm[i], p.local.nrm[i + 1], p.local.nrm[i + 2]).transformDirection(M);
          worst = Math.max(worst, Math.abs(n.x - nrm[i]) * 100, Math.abs(n.y - nrm[i + 1]) * 100, Math.abs(n.z - nrm[i + 2]) * 100);
        }
        for (let i = 0; i < p.edges.length; i += 3) {
          const v = new T.Vector3(p.local.edges[i], p.local.edges[i + 1], p.local.edges[i + 2]).applyMatrix4(M);
          worst = Math.max(worst, Math.abs(v.x - p.edges[i]), Math.abs(v.y - p.edges[i + 1]), Math.abs(v.z - p.edges[i + 2]));
        }
        // the bounding box follows
        const b = new T.Box3().setFromBufferAttribute(p.mesh.geometry.getAttribute('position'));
        worst = Math.max(worst, b.min.distanceTo(p.box.min), b.max.distanceTo(p.box.max));
      }
      out.worst = worst;
      // BVH follows (refit): a ray aimed at a moved part's face centroid hits it at the expected distance
      const p = t.parts.find((x) => x.link === 'finger_l');
      const g = p.mesh.geometry, idx = g.getIndex().array, pos = g.getAttribute('position').array;
      const A = new T.Vector3().fromArray(pos, idx[0] * 3), B = new T.Vector3().fromArray(pos, idx[1] * 3), C = new T.Vector3().fromArray(pos, idx[2] * 3);
      const c = A.clone().add(B).add(C).divideScalar(3), n = new T.Vector3().crossVectors(B.clone().sub(A), C.clone().sub(A)).normalize();
      if (!g.boundsTree) g.computeBoundsTree();
      const rc = new T.Raycaster(c.clone().addScaledVector(n, 50), n.clone().negate());
      rc.firstHitOnly = true;
      const hit = rc.intersectObject(p.mesh, false)[0];
      out.hitErr = hit ? Math.abs(hit.distance - 50) : -1;
      out.values = Object.fromEntries(R.ui.map((j) => [j.name, document.querySelector(`#jointList .jrow[data-j="${j.name}"] .jnum`).value]));
      out.mimicDisabled = document.querySelector('#jointList .jrow[data-j="grip_r"] .jpos').disabled;
      out.slider = Array.from(t.parts.find((x) => x.link === 'slider').mesh.geometry.getAttribute('position').array.slice(0, 3));
      return out;
    });
    check(st.worst < 1e-3, 'positions, normals, CAD edges and bounds follow the moved links', `max err ${st.worst.toExponential(2)} mm`);
    check(st.hitErr >= 0 && st.hitErr < 1e-3, 'BVH is refitted: raycast on a moved part hits where its face now is', `err ${st.hitErr}`);
    check(st.values.grip_r === '-34.3' && st.mimicDisabled, 'mimic joint follows its master (-2 × 20° + 0.1 rad) and cannot be dragged', JSON.stringify(st.values));
    check(st.values.spin === '200.0' && st.values.extend === '30.00', 'continuous joint takes 200°, prismatic shows mm', JSON.stringify(st.values));
    check(st.slider.some((v, i) => Math.abs(v - armBefore.pos[i]) > 1), 'a link below moved joints is re-placed');
    await shot('synthetic-moved');

    // limits clamp; "한계 무시" lifts them; reset goes home
    await setUi('shoulder', 170, 'num');
    await frames();
    let v = await ev(() => document.querySelector('#jointList .jrow[data-j="shoulder"] .jnum').value);
    check(v === '85.9', 'number box is clamped to the joint limit (1.5 rad = 85.9°)', v);
    await ev(() => { const c = document.getElementById('jointFree'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await setUi('shoulder', 170, 'num');
    await frames();
    v = await ev(() => document.querySelector('#jointList .jrow[data-j="shoulder"] .jnum').value);
    check(v === '170.0', 'with "한계 무시" the joint goes past its limit', v);
    await ev(() => { const c = document.getElementById('jointFree'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await frames();
    v = await ev(() => document.querySelector('#jointList .jrow[data-j="shoulder"] .jnum').value);
    check(v === '85.9', 'switching "한계 무시" off brings the joint back inside its limits', v);
    await ev(() => document.getElementById('btnJointHome').click());
    await frames();
    await compareFk({}, 'after 초기화');
    // a master stops where a mimic follower reaches its own limit, through a chain:
    // grip_r = -2·q + 0.1 in [-1, 1] -> q in [-0.45, 0.55]; grip_r2 = 3·grip_r + 0.2 = -6·q + 0.5 in [-3, 2.5] -> q in [-1/3, 7/12]
    await setUi('grip_l', (-0.5 * 180) / Math.PI);
    await frames();
    v = await ev(() => ['grip_l', 'grip_r', 'grip_r2'].map((n) => document.querySelector(`#jointList .jrow[data-j="${n}"] .jnum`).value).join(' '));
    const gmin = await ev(() => document.querySelector('#jointList .jrow[data-j="grip_l"] .jpos').min);
    check(v === '-19.1 43.9 143.2' && Math.abs(Number(gmin) + 19.0986) < 0.01, 'a master stops where a mimic follower (2-level chain) hits its limit; relations kept', `${v}, slider min ${gmin}`);
    await compareFk({ grip_l: -1 / 3 }, 'master held by a mimic chain limit');
    await ev(() => document.getElementById('btnJointHome').click());
    await frames();

    // clicking a joint name selects what it moves
    const sel = await ev(() => { document.querySelector('#jointList .jrow[data-j="extend"] .jname').click(); return [...window.__sv.active.selection].map((p) => p.link).sort().join(','); });
    check(sel === 'ball,finger_l,finger_r,slider', 'joint name selects the moved sub-tree', sel);
    const selG = await ev(() => { document.querySelector('#jointList .jrow[data-j="grip_l"] .jname').click(); return [...window.__sv.active.selection].map((p) => p.link).sort().join(','); });
    check(selG === 'ball,finger_l,finger_r', 'joint name also selects what its mimic followers move', selG);
    // hovering a row draws its axis
    await page.hover('#jointList .jrow[data-j="shoulder"] .jname');
    await frames();
    const axis = await ev(() => { const t = window.__sv.active; return !!t.jointAxisObj && t.jointAxisObj.parent === t.overlay && t.robot.axisJoint.name; });
    check(axis === 'shoulder', 'hovering a joint shows its axis', String(axis));
    await shot('synthetic-axis');

    // section caps stay valid while joints move; picked faces of a moved part are dropped
    await ev(() => { const cb = document.querySelector('.sec-row[data-axis="x"] .sec-on'); document.getElementById('btnSection').click(); cb.checked = true; cb.dispatchEvent(new Event('change')); });
    await ev(() => {
      const t = window.__sv.active, p = t.parts.find((x) => x.link === 'arm');
      window.__sv.selectParts([p]);
      window.__sv.setEntities(t, [{ kind: 'face', part: p, f: 0, point: p.box.getCenter(new window.__sv.THREE.Vector3()), viewNormal: new window.__sv.THREE.Vector3(0, 0, 1), key: `${p.id}:f:0` }]);
    });
    await setUi('shoulder', 30);
    await frames();
    st = await ev(() => ({ caps: window.__sv.active.caps.length, ents: window.__sv.active.entities.length }));
    check(st.caps === 1 && st.ents === 0, 'section caps rebuilt after a joint move; stale face picks dropped', JSON.stringify(st));
    await shot('synthetic-section');
    // without caps the plane handle and the slider range still follow the moved model
    await ev(() => { const c = document.getElementById('secCaps'); c.checked = false; c.dispatchEvent(new Event('change')); });
    const before = await ev(() => ({ o: window.__sv.active.sectionHandles[0].origin.toArray(), box: window.__sv.active.box.max.toArray() }));
    await setUi('extend', 50);
    await setUi('shoulder', -50);
    await frames();
    const after = await ev(() => ({ o: window.__sv.active.sectionHandles[0].origin.toArray(), box: window.__sv.active.box.max.toArray(), caps: window.__sv.active.caps.length }));
    check(after.caps === 0 && after.o.some((x, i) => Math.abs(x - before.o[i]) > 1e-3) && after.box.some((x, i) => Math.abs(x - before.box[i]) > 1e-3),
      'section plane handle follows the moved model with caps off', JSON.stringify({ before, after }));
    await ev(() => { const c = document.getElementById('secCaps'); c.checked = true; c.dispatchEvent(new Event('change')); document.getElementById('btnJointHome').click(); });
    await frames();
    await ev(() => { const cb = document.querySelector('.sec-row[data-axis="x"] .sec-on'); cb.checked = false; cb.dispatchEvent(new Event('change')); document.getElementById('btnSection').click(); });

    // keyboard J toggles the panel; a non-robot tab hides button and panel
    await page.mouse.click(700, 500);
    await page.keyboard.press('j');
    check(await ev(() => document.getElementById('jointPanel').classList.contains('hidden')), 'J hides the joint panel');
    await page.keyboard.press('j');
    check(await ev(() => !document.getElementById('jointPanel').classList.contains('hidden')), 'J shows it again');

    // leaving the tab hides the joint axis
    await page.hover('#jointList .jrow[data-j="spin"] .jname');
    await frames();
    const robotTab = await ev(() => window.__sv.tabs.indexOf(window.__sv.active));
    // ---------------- web-style open: URDF + mesh files picked together (references matched by file name)
    await (await page.$('#fileInput')).uploadFile(...synth.flat);
    await waitLoaded(2);
    st = await ev(() => { const t = window.__sv.active; return { n: window.__sv.tabs.length, links: t.parts.map((p) => p.link).sort().join(','), missing: t.missing, name: t.name }; });
    check(st.n === 2 && st.name === 'bot.urdf' && st.links === 'arm,ball,base,finger_l,finger_r,plate,slider,turret', 'URDF + meshes opened together: one tab, references matched by name', JSON.stringify(st));
    // a single STL opens as a part (no joints)
    await (await page.$('#fileInput')).uploadFile(path.join(tmp, 'bot_description', 'meshes', 'arm.stl'));
    await waitLoaded(3);
    st = await ev(() => ({ parts: window.__sv.active.parts.length, faces: window.__sv.active.parts[0].faceFirst.length, robot: !!window.__sv.active.robot,
      btn: document.getElementById('btnJoints').classList.contains('hidden'), panel: document.getElementById('jointPanel').classList.contains('hidden') }));
    check(st.parts === 1 && st.faces === 6 && !st.robot && st.btn && st.panel, 'a plain STL opens as one part; joint button/panel hidden on non-robot tabs', JSON.stringify(st));
    const ax = await ev((i) => { const t = window.__sv.tabs[i]; return { obj: !!t.jointAxisObj, vis: t.jointAxisObj && t.jointAxisObj.visible, j: t.robot.axisJoint }; }, robotTab);
    check(ax.obj && !ax.vis && !ax.j, 'switching tabs hides the joint axis', JSON.stringify(ax));
    await ev(() => document.querySelectorAll('.tab')[0].click());
    check(await ev(() => !document.getElementById('btnJoints').classList.contains('hidden') && !document.getElementById('jointPanel').classList.contains('hidden')), 'back on the robot tab the joint panel returns');

    // ---------------- mimic edge cases: multiplier 0 (constant follower) and a tiny multiplier
    const m0 = path.join(tmp, 'bot_description', 'urdf', 'mimic0.urdf');
    fs.writeFileSync(m0, `<robot name="m0"><link name="a"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link><link name="b"/><link name="c"/><link name="d"/>
  <joint name="m" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
  <joint name="zero" type="revolute"><parent link="a"/><child link="c"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/><mimic joint="m" multiplier="0" offset="2"/></joint>
  <joint name="tiny" type="revolute"><parent link="a"/><child link="d"/><axis xyz="0 0 1"/><limit lower="-5e-14" upper="5e-14"/><mimic joint="m" multiplier="1e-13"/></joint>
  <link name="e"/><link name="f"><visual><geometry><box size="0.01 0.01 0.01"/></geometry><material name="none"><color rgba="1 0 0 0"/></material></visual></link>
  <joint name="slide" type="prismatic"><parent link="a"/><child link="e"/><axis xyz="1 0 0"/><limit lower="0" upper="1"/></joint>
  <joint name="clash" type="prismatic"><parent link="a"/><child link="f"/><axis xyz="1 0 0"/><limit lower="-1" upper="-5e-13"/><mimic joint="slide"/></joint></robot>`);
    const nT = await ev(() => window.__sv.tabs.length);
    await post([m0]);
    await waitLoaded(nT + 1);
    st = await ev(() => { const r = (n) => document.querySelector(`#jointList .jrow[data-j="${n}"] .jpos`); const R = window.__sv.active.robot;
      const pf = window.__sv.active.parts.find((p) => p.link === 'f');
      return { alpha0: pf.opacity === 0 && !pf.mesh.visible, min: r('m').min, max: r('m').max, smin: r('slide').min, smax: r('slide').max, home: R.byName.get('slide').value, toast: document.getElementById('toast').textContent }; });
    check(st.alpha0, 'a visual with alpha 0 is invisible', JSON.stringify(st.alpha0));
    check(Number(st.smin) === 0 && Number(st.smax) === 1000 && st.home === 0 && /맞는 범위가 없습니다/.test(st.toast), 'an empty master/mimic common range is reported and the own limits are kept', JSON.stringify(st));
    check(Math.abs(Number(st.min) + 28.648) < 0.01 && Math.abs(Number(st.max) - 28.648) < 0.01 && /상수 2/.test(st.toast),
      'mimic multiplier 0 out of limits is reported; a tiny multiplier still narrows the master ([-0.5, 0.5] rad)', JSON.stringify(st));
    await ev(() => window.__sv.tabs.length && document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());

    // ---------------- picked by path together with its meshes (native '열기' dialog, MCP): the meshes only serve
    // the URDF, one tab. From the command line / Explorer every file keeps its own tab (as in 0.0.6).
    {
      const meshDir = path.join(tmp, 'bot_description', 'meshes');
      const n0 = await ev(() => window.__sv.tabs.length);
      await post([synth.file, path.join(meshDir, 'arm.stl')]);
      await waitLoaded(n0 + 2);
      const cl = await ev((k) => window.__sv.tabs.slice(k).map((t) => t.name).sort(), n0);
      check(JSON.stringify(cl) === JSON.stringify(['arm.stl', 'bot.urdf']), 'command line / Explorer: each file given together opens as its own tab', JSON.stringify(cl));
      for (let i = 0; i < 2; i++) await ev(() => document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());
      const n1 = await ev(() => window.__sv.tabs.length);
      await pick([synth.file, ...fs.readdirSync(meshDir).filter((f) => /\.(stl|obj)$/i.test(f)).map((f) => path.join(meshDir, f))]);
      await waitLoaded(n1 + 1);
      await wait(500);
      const s2 = await ev(() => ({ n: window.__sv.tabs.length, name: window.__sv.active.name, joints: window.__sv.active.robot && window.__sv.active.robot.ui.length, toast: document.getElementById('toast').textContent }));
      check(s2.n === n1 + 1 && s2.joints > 0 && s2.name === 'bot.urdf', 'a URDF picked together with its meshes opens as one robot tab', JSON.stringify({ before: n1, ...s2 }));
      await ev(() => window.__sv.tabs.length && document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());
      // a mesh chosen together from a folder the URDF lookup never searches is still used
      const far = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-urdf-far-')), near = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-urdf-near-'));
      try {
        fs.copyFileSync(path.join(meshDir, 'arm.stl'), path.join(far, 'far_arm.stl'));
        const fu = path.join(near, 'far.urdf');
        fs.writeFileSync(fu, '<robot name="far"><link name="a"><visual><geometry><mesh filename="package://nowhere/meshes/far_arm.stl"/></geometry></visual></link></robot>');
        const n2 = await ev(() => window.__sv.tabs.length);
        await pick([fu, path.join(far, 'far_arm.stl')]);
        await waitLoaded(n2 + 1);
        const s3 = await ev(() => ({ n: window.__sv.tabs.length, name: window.__sv.active.name, parts: window.__sv.active.parts.length, missing: window.__sv.active.missing }));
        check(s3.n === n2 + 1 && s3.name === 'far.urdf' && s3.parts === 1 && !s3.missing.length, 'a mesh chosen together from another folder is used by the URDF', JSON.stringify(s3));
        await ev(() => window.__sv.tabs.length && document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());
        // two packages with a same-named mesh opened together: each URDF gets its own package's mesh,
        // found next to it (pkg/urdf + pkg/meshes) and, from far away, by the longest matching path
        const sizeOf = (s) => binaryStl(boxTris(s, s, s));
        for (const [pk, s] of [['pa', 0.05], ['pb', 0.2]]) {
          fs.mkdirSync(path.join(near, pk, 'urdf'), { recursive: true }); fs.mkdirSync(path.join(near, pk, 'meshes'), { recursive: true });
          fs.writeFileSync(path.join(near, pk, 'meshes', 'link.stl'), sizeOf(s));
          fs.writeFileSync(path.join(near, pk, 'urdf', `${pk}.urdf`), `<robot name="${pk}"><link name="a"><visual><geometry><mesh filename="package://${pk}/meshes/link.stl"/></geometry></visual></link></robot>`);
          fs.mkdirSync(path.join(far, pk, 'meshes'), { recursive: true });
          fs.writeFileSync(path.join(far, pk, 'meshes', 'link.stl'), sizeOf(s));
          fs.mkdirSync(path.join(near, 'iso', 'sub'), { recursive: true });
          fs.writeFileSync(path.join(near, 'iso', 'sub', `far_${pk}.urdf`), `<robot name="far_${pk}"><link name="a"><visual><geometry><mesh filename="package://${pk}/meshes/link.stl"/></geometry></visual></link></robot>`);
        }
        // same-named but unrelated meshes next to the URDFs (also at meshes/link.stl, the package path without the
        // package name): only fallbacks, the chosen package mesh wins
        fs.writeFileSync(path.join(near, 'iso', 'sub', 'link.stl'), sizeOf(0.01));
        fs.mkdirSync(path.join(near, 'iso', 'sub', 'meshes'));
        fs.writeFileSync(path.join(near, 'iso', 'sub', 'meshes', 'link.stl'), sizeOf(0.01));
        const sizes = async (n) => ev((k) => window.__sv.tabs.slice(k).map((t) => [t.name, Math.round(t.box.max.x - t.box.min.x), t.missing.length]), n);
        let n3 = await ev(() => window.__sv.tabs.length);
        await pick([path.join(near, 'pa', 'urdf', 'pa.urdf'), path.join(near, 'pb', 'urdf', 'pb.urdf'), path.join(near, 'pa', 'meshes', 'link.stl'), path.join(near, 'pb', 'meshes', 'link.stl')]);
        await waitLoaded(n3 + 2);
        let sz = await sizes(n3);
        check(JSON.stringify(sz) === JSON.stringify([['pa.urdf', 50, 0], ['pb.urdf', 200, 0]]), 'same-named meshes of two packages chosen together: each URDF uses its own', JSON.stringify(sz));
        for (let i = 0; i < 2; i++) await ev(() => document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());
        n3 = await ev(() => window.__sv.tabs.length);
        await pick([path.join(near, 'iso', 'sub', 'far_pa.urdf'), path.join(near, 'iso', 'sub', 'far_pb.urdf'), path.join(far, 'pb', 'meshes', 'link.stl'), path.join(far, 'pa', 'meshes', 'link.stl')]);
        await waitLoaded(n3 + 2);
        sz = await sizes(n3);
        check(JSON.stringify(sz) === JSON.stringify([['far_pa.urdf', 50, 0], ['far_pb.urdf', 200, 0]]), 'same-named meshes chosen from elsewhere: matched by package path, ahead of a same-named file next to the URDF', JSON.stringify(sz));
        for (let i = 0; i < 2; i++) await ev(() => document.querySelectorAll('.tab .x')[window.__sv.tabs.length - 1].click());
      } finally { fs.rmSync(far, { recursive: true, force: true }); fs.rmSync(near, { recursive: true, force: true }); }
      // the native dialog endpoint is not reachable from other sites (custom header -> CORS preflight)
      const r = await fetch(`http://127.0.0.1:${PORT}/api/pick-files`, { method: 'POST' });
      check(r.status === 403, '/api/pick-files needs the app header', String(r.status));
    }

    // ---------------- a real robot
    if (real) {
      const n0 = await ev(() => window.__sv.tabs.length);
      const t0 = Date.now();
      await post([real]);
      await waitLoaded(n0 + 1);
      const info = await ev(() => { const t = window.__sv.active; return { parts: t.parts.length, tris: t.triCount, missing: t.missing, joints: t.robot.ui.length, load: t.loadInfo, name: t.name }; });
      check(info.parts > 0 && info.missing.length === 0, `${path.basename(real)}: loaded`, `${Date.now() - t0} ms, ${info.parts} parts, ${info.tris} tris, ${info.joints} joints, ${info.load}`);
      await compareFkReal();
      await shot('real-home');
      // sweep every joint through its range; time the re-placement
      const perf = await ev(async () => {
        const t = window.__sv.active, R = t.robot, out = [];
        for (const j of R.ui) {
          if (j.master) continue;
          const row = document.querySelector(`#jointList .jrow[data-j="${j.name}"] .jpos`);
          const lo = Number(row.min), hi = Number(row.max);
          let worst = 0;
          for (let k = 0; k <= 10; k++) {
            row.value = String(lo + ((hi - lo) * k) / 10);
            row.dispatchEvent(new Event('input', { bubbles: true }));
            const s = performance.now();
            await new Promise((r) => requestAnimationFrame(r));
            worst = Math.max(worst, performance.now() - s);
          }
          out.push([j.name, Math.round(worst)]);
        }
        return out;
      });
      console.log('      slowest frame per joint sweep (ms):', perf.map((p) => p.join(' ')).join(', '));
      check(perf.every((p) => p[1] < 250), 'every joint sweeps without long stalls');
      // re-placing one link with CAD edges and a capped section on: only the moved part is recut / re-uploaded
      const pt = await ev(async () => {
        const sv = window.__sv, t = sv.active, R = t.robot;
        const cb = document.querySelector('.sec-row[data-axis="y"] .sec-on');
        cb.checked = true; cb.dispatchEvent(new Event("change"));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // section edges built
        const edgeObj = t.edgeObjs[0];
        const j = R.ui.find((x) => !x.master);
        const times = [];
        for (let k = 0; k < 10; k++) {
          j.value = j.lower + ((j.upper - j.lower) * k) / 9;
          const s = performance.now();
          sv.poseRobot(t);
          times.push(performance.now() - s);
        }
        const caps = t.caps.length, edgesKept = !t.edgeDirty && t.edgeObjs[0] === edgeObj;
        cb.checked = false; cb.dispatchEvent(new Event('change'));
        times.sort((a, b) => a - b);
        return { joint: j.name, median: times[5], max: times[9], caps, edgesKept };
      });
      check(pt.caps === 1 && pt.edgesKept && pt.median < 40, 'one joint step (FK + re-placing + edges + section) is fast with caps on', JSON.stringify(pt));
      // a flexed pose for the screenshot: middle of every range
      await ev(() => { for (const el of document.querySelectorAll('#jointList .jpos')) { if (el.disabled) continue; el.value = String((Number(el.min) + Number(el.max)) / 2); el.dispatchEvent(new Event('input', { bubbles: true })); } });
      await frames();
      await shot('real-mid');
      async function compareFkReal() {
        const text2 = fs.readFileSync(real, 'utf8');
        const vals = await ev(() => Object.fromEntries(window.__sv.active.robot.joints.map((j) => [j.name, j.value])));
        const got = await ev(() => { const R = window.__sv.active.robot; const o = {}; for (const [n, l] of R.links) o[n] = l.world.elements.slice(); return o; });
        const W = fk(text2, vals);
        let worst = 0;
        for (const [n, w] of Object.entries(W)) for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got[n][12 + i] - w.t[i]) / 1000);
        check(worst < 1e-6, `${path.basename(real)}: forward kinematics matches the independent computation`, `max err ${worst.toExponential(2)}`);
      }
    }

    check(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
  } catch (e) {
    console.error(e);
    fails.push(String(e && e.message));
  } finally { // only what was created
    if (browser) await browser.close().catch(() => {});
    if (srv) srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (profile) try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
  process.exit(fails.length ? 1 : 0);
})();
