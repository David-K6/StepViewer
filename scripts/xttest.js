// Parasolid X_T reader regression test (Node, no browser). Exit code 1 on any failed check.
// usage: node scripts/xttest.js <file.x_t> [--ref reference.step] [<file.x_t> [--ref ...]]...
//  - every body converts (no skipped faces / failed edges), every solid tessellates to a closed mesh with positive volume
//  - with --ref: face count, surface area and bounding box equal the reference STEP export of the same part
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const XT = require('../app/xtfile.js');
const occtimportjs = require('occt-import-js');

const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };
const PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };

function summarize(meshes) {
  let faces = 0, area = 0, vol = 0, boundary = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.attributes.position.array, ix = m.index.array;
    faces += (m.brep_faces || []).length;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
    const q = 1e4, ids = new Map(), ec = new Map();
    const vid = (i) => { const k = `${Math.round(p[i * 3] * q)},${Math.round(p[i * 3 + 1] * q)},${Math.round(p[i * 3 + 2] * q)}`; let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], w = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
      vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
      const v = [vid(ix[t]), vid(ix[t + 1]), vid(ix[t + 2])];
      for (let e = 0; e < 3; e++) { const x = v[e], y = v[(e + 1) % 3]; if (x === y) continue; const k = x < y ? `${x}_${y}` : `${y}_${x}`; ec.set(k, (ec.get(k) || 0) + 1); }
    }
    for (const c of ec.values()) if (c === 1) boundary++;
  }
  return { faces, area, vol, boundary, bbox: [...lo, ...hi] };
}

(async () => {
  const args = process.argv.slice(2);
  const jobs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref') { if (jobs.length) jobs[jobs.length - 1].ref = args[++i]; }
    else jobs.push({ file: args[i] });
  }
  if (!jobs.length) { console.log('usage: node scripts/xttest.js <file.x_t> [--ref reference.step] ...'); process.exit(2); }
  const occt = await occtimportjs();
  for (const { file, ref } of jobs) {
    const name = path.basename(file);
    const t0 = Date.now();
    let conv;
    try { conv = XT.toStep(new Uint8Array(fs.readFileSync(file))); } catch (e) { check(false, `${name}: converts`, e.message); continue; }
    const st = conv.stats;
    check(!st.skippedFaces && !st.failedEdges && !st.failedBodies && !Object.keys(st.unsupported).length,
      `${name}: every body/face/edge converts`, `${st.bodies} bodies, ${st.faces} faces, ${st.approxEdges} approximated edges, ${Date.now() - t0} ms${Object.keys(st.unsupported).length ? ' unsupported ' + JSON.stringify(st.unsupported) : ''}${st.lastError ? ' ' + st.lastError : ''}`);
    const t1 = Date.now();
    const res = occt.ReadStepFile(new TextEncoder().encode(conv.step), PARAMS);
    check(res.success, `${name}: OpenCascade reads the converted STEP`, `${Date.now() - t1} ms`);
    if (!res.success) continue;
    const byKey = new Map(conv.bodies.map((b) => [b.key, b]));
    let open = 0, nonPositive = 0, solids = 0;
    const all = [];
    const walk = (n) => {
      const b = byKey.get(n.name);
      if (b) {
        const ms = [];
        const collect = (x) => { for (const mi of x.meshes || []) ms.push(res.meshes[mi]); for (const c of x.children || []) collect(c); };
        collect(n);
        all.push(...ms);
        if (b.solid) { solids++; const s = summarize(ms); if (s.boundary) open++; else if (s.vol <= 0) nonPositive++; }
        return;
      }
      for (const c of n.children || []) walk(c);
    };
    walk(res.root);
    check(all.length > 0 && open === 0 && nonPositive === 0, `${name}: every solid is closed with positive volume`, `${solids} solids, open ${open}, non-positive ${nonPositive}`);
    if (ref) {
      const a = summarize(all), r = summarize(occt.ReadStepFile(new Uint8Array(fs.readFileSync(ref)), PARAMS).meshes);
      const bb = Math.max(...a.bbox.map((x, i) => Math.abs(x - r.bbox[i])));
      check(a.faces === r.faces && Math.abs(a.area / r.area - 1) < 1e-3 && bb < 1e-3, `${name}: matches ${path.basename(ref)} (faces, area, bbox)`,
        `faces ${a.faces}/${r.faces}, area ${a.area.toFixed(3)}/${r.area.toFixed(3)} mm², bbox diff ${bb.toFixed(5)} mm`);
    }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
