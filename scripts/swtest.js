// SolidWorks reader regression test (Node, no browser). Exit code 1 on any failed check.
// usage: node scripts/swtest.js <file.SLDASM|file.SLDPRT>... [--pair part.SLDPRT=reference.step]...
//  - SLDASM: visible geometry bbox == SolidWorks' stored root bbox; embedded-cache path == fallback path
//            (sibling SLDPRT / original STEP files, as the viewer resolves them) per component.
//  - SLDPRT with --pair: face count, bbox and area against the STEP export (OpenCascade).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SW = require('../app/swfile.js');
const occtimportjs = require('occt-import-js');

const fails = [];
const validColor = (c) => Array.isArray(c) && c.length === 3 && c.every((x) => x >= 0 && x <= 1);
const hexColor = (c) => (validColor(c) ? '#' + c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('') : String(c));
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };

let occtP = null;
const occt = () => (occtP ||= occtimportjs());
async function readStep(buf) {
  const o = await occt();
  const r = o.ReadStepFile(new Uint8Array(buf), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
  if (!r.success) throw new Error('STEP read failed');
  return r.meshes.map((m) => {
    const faces = m.brep_faces || [];
    return {
      name: m.name, color: m.color, position: new Float32Array(m.attributes.position.array),
      normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      index: new Uint32Array(m.index.array),
      faceFirst: Int32Array.from(faces, (f) => f.first), faceLast: Int32Array.from(faces, (f) => f.last),
    };
  });
}
// same matching rules as server.js findSibling
function resolverFor(dir) {
  const names = fs.readdirSync(dir);
  return async (want) => {
    const w = want.toLowerCase();
    let hit = names.find((n) => n.toLowerCase() === w);
    if (!hit) {
      const ext = path.extname(w), stem = w.slice(0, -ext.length);
      hit = names.filter((n) => { const l = n.toLowerCase(); return l.endsWith(ext) && l.length > w.length && l.startsWith(stem) && '_ -'.includes(l[stem.length]); })
        .sort((a, b) => a.length - b.length)[0];
    }
    return hit ? fs.readFileSync(path.join(dir, hit)).buffer : null;
  };
}
const area = (m) => {
  const p = m.position, I = m.index; let A = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    A += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return A;
};
const bbox = (ms) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const m of ms) for (let i = 0; i < m.position.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], m.position[i + a]); mx[a] = Math.max(mx[a], m.position[i + a]); }
  return { mn, mx };
};
const boxDiff = (A, B) => Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(A.mn[a] - B.mn[a]), Math.abs(A.mx[a] - B.mx[a])]));
const fmtBox = (b) => `[${b.mn.map((v) => v.toFixed(2))}]..[${b.mx.map((v) => v.toFixed(2))}]`;
const faces = (ms) => ms.reduce((s, m) => s + m.faceFirst.length, 0);

/** top-level instance -> its meshes (by tree path) */
function byInstance(r) {
  const out = new Map();
  for (const n of r.tree.children) {
    const ms = [];
    const walk = (x) => { for (const i of x.meshes) ms.push(r.meshes[i]); x.children.forEach(walk); };
    walk(n);
    out.set(n.name, ms);
  }
  return out;
}

async function testAssembly(file) {
  const u8 = new Uint8Array(fs.readFileSync(file));
  const name = path.basename(file);
  const resolve = resolverFor(path.dirname(file));
  const t0 = performance.now();
  const r = await SW.read(u8, name, resolve, { readStep });
  const ms = performance.now() - t0;
  check(r.meshes.length > 0 && r.missing.length === 0, `${name}: all components from the embedded cache`, `${r.meshes.length} parts, ${(ms / 1000).toFixed(2)} s, missing ${JSON.stringify(r.missing)}`);
  check(r.meshes.every((m) => validColor(m.color)), `${name}: every component has a color`, [...new Set(r.meshes.map((m) => hexColor(m.color)))].join(' '));
  // SolidWorks' stored bbox of the root model (meters)
  const c = new SW.Container(u8);
  const { root } = SW.parseCompTree(new TextDecoder().decode(await c.get('swXmlContents/COMPINSTANCETREE')));
  const sb = (root.swBoundingBox || '').split(/\s+/).map(Number);
  if (sb.length === 6) {
    const ref = { mn: sb.slice(0, 3).map((v) => v * 1000), mx: sb.slice(3).map((v) => v * 1000) };
    const got = bbox(r.meshes.filter((m) => !m.hidden));
    const d = boxDiff(ref, got);
    check(d < 0.05, `${name}: visible bbox matches SolidWorks' stored bbox`, `diff ${d.toFixed(4)} mm ${fmtBox(got)}`);
  }
  // fallback (no embedded cache) must place every resolvable component identically
  const t1 = performance.now();
  let f;
  try { f = await SW.read(u8, name, resolve, { readStep, noCache: true }); } catch (e) {
    console.log(`SKIP  ${name}: no component resolvable without the embedded cache (${e.message})`);
    return;
  }
  const A = byInstance(r), B = byInstance(f);
  let worst = 0, compared = 0;
  const off = [];
  for (const [k, msA] of A) {
    const msB = B.get(k);
    if (!msB || !msB.length) continue;
    compared++;
    const d = boxDiff(bbox(msA), bbox(msB));
    worst = Math.max(worst, d);
    if (d > 0.05) off.push(`${k} ${d.toFixed(3)}mm`);
  }
  check(off.length === 0 && compared > 0, `${name}: fallback path (sibling files / STEP) places components like the cache`,
    `${compared}/${A.size} compared, worst ${worst.toFixed(4)} mm, missing ${JSON.stringify(f.missing)}, ${((performance.now() - t1) / 1000).toFixed(1)} s${off.length ? ' OFF: ' + off.join(', ') : ''}`);
}

async function testPart(file, stepFile) {
  const name = path.basename(file);
  const r = await SW.read(new Uint8Array(fs.readFileSync(file)), name);
  const m = r.meshes[0];
  check(m.faceFirst.length > 0 && m.index.length > 0, `${name}: decoded`, `${m.faceFirst.length} faces, ${m.index.length / 3} tris`);
  check(validColor(m.color), `${name}: SolidWorks appearance color read`, hexColor(m.color));
  if (!stepFile) return;
  const ref = await readStep(fs.readFileSync(stepFile));
  const fa = faces(r.meshes), fb = faces(ref);
  check(fa === fb, `${name}: face count equals STEP`, `${fa} vs ${fb}`);
  const d = boxDiff(bbox(r.meshes), bbox(ref));
  check(d < 0.05, `${name}: bbox equals STEP`, `diff ${d.toFixed(4)} mm`);
  const aa = r.meshes.reduce((s, x) => s + area(x), 0), ab = ref.reduce((s, x) => s + area(x), 0);
  const rel = Math.abs(aa - ab) / ab;
  check(rel < 0.005, `${name}: surface area within 0.5% of STEP`, `${aa.toFixed(1)} vs ${ab.toFixed(1)} mm² (${(rel * 100).toFixed(3)}%)`);
}

(async () => {
  const args = process.argv.slice(2);
  const pairs = new Map();
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pair') { const [a, b] = args[++i].split('='); pairs.set(path.resolve(a), path.resolve(b)); files.push(path.resolve(a)); } else files.push(path.resolve(args[i]));
  }
  if (!files.length) { console.log('usage: node scripts/swtest.js <file.SLDASM|file.SLDPRT>... [--pair part.SLDPRT=ref.step]'); process.exit(2); }
  for (const f of [...new Set(files)]) {
    try {
      if (/\.sldasm$/i.test(f)) await testAssembly(f);
      else await testPart(f, pairs.get(f));
    } catch (e) { check(false, `${path.basename(f)}: ${e.message}`); }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
