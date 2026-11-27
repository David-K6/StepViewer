// STL reader regression test (Node, no browser). Exit code 1 on any failed check.
// usage: node scripts/stltest.js [model.step ...]
// Each STEP model is tessellated with OpenCascade and written as binary STL (all parts in one solid) and ASCII STL
// (one "solid" per part, as written by CAD exporters, with -0 and exponent numbers). Then app/stlfile.js reads both:
//  - triangle count, surface area and bounding box equal the source mesh
//  - the ASCII file gives one part per solid with the solid's name
//  - flat B-rep faces come back as single planar faces (same area and normal), every face is edge-connected
//  - each face's triangles form a contiguous range and borders get their own vertices (sharp creases)
//  - hand-made cases: a binary header starting with "solid", a cube (6 faces), a 64-sided cylinder (1 curved side),
//    degenerate triangles, truncated / non-numeric input rejected with a message
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const occtimportjs = require('occt-import-js');
const STL = require('../app/stlfile.js');

const root = path.join(__dirname, '..');
const fails = [];
const check = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  ' + extra : ''}`); if (!cond) fails.push(msg); };
const PLANE_COS = Math.cos((STL.PLANE_ANGLE * Math.PI) / 180);
const PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 };

const triArea = (p, a, b, c) => {
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
};
/** source parts -> [{ name, tris: Float32Array(9n), faces: [{ area, normal|null }] }] */
function sourceParts(res) {
  return res.meshes.map((m, i) => {
    const p = m.attributes.position.array, ix = m.index.array;
    const tris = new Float32Array(ix.length * 3);
    for (let k = 0; k < ix.length; k++) for (let c = 0; c < 3; c++) tris[k * 3 + c] = p[ix[k] * 3 + c];
    const faces = (m.brep_faces || []).map((f) => {
      let area = 0; const n = [0, 0, 0]; let planar = true, n0 = null, big = 0, nBig = null;
      const units = [];
      for (let t = f.first; t <= f.last; t++) {
        const cr = triArea(tris, t * 9, t * 9 + 3, t * 9 + 6), l = Math.hypot(...cr);
        if (!l) continue;
        area += l / 2; n[0] += cr[0]; n[1] += cr[1]; n[2] += cr[2];
        const u = cr.map((x) => x / l);
        units.push(u);
        if (l > big) { big = l; nBig = u; }
        if (!n0) n0 = u; else if (Math.abs(u[0] * n0[0] + u[1] * n0[1] + u[2] * n0[2]) < 0.99995) planar = false;
      }
      const l = Math.hypot(...n);
      // strict: every normal within the reader's plane angle of the largest triangle's (the reader never splits these)
      const strict = planar && units.every((u) => u[0] * nBig[0] + u[1] * nBig[1] + u[2] * nBig[2] >= PLANE_COS);
      return { area, normal: planar && l ? n.map((x) => x / l) : null, strict };
    });
    return { name: m.name || `part${i + 1}`, tris, faces };
  });
}
function binarySTL(tris, header = 'StepViewer test') {
  const n = tris.length / 9, buf = Buffer.alloc(84 + n * 50);
  buf.write(header.slice(0, 80), 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) buf.writeFloatLE(tris[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
function asciiSTL(parts) {
  const fmt = (x) => (Object.is(x, -0) ? '-0' : x.toExponential(8)); // exporters write e-notation
  const out = [];
  for (const p of parts) {
    out.push(`solid ${p.name}`);
    for (let t = 0; t < p.tris.length; t += 9) {
      out.push('  facet normal 0 0 0', '    outer loop');
      for (let c = 0; c < 9; c += 3) out.push(`      vertex ${fmt(p.tris[t + c])} ${fmt(p.tris[t + c + 1])} ${fmt(p.tris[t + c + 2])}`);
      out.push('    endloop', '  endfacet');
    }
    out.push(`endsolid ${p.name}`);
  }
  return new TextEncoder().encode(out.join('\r\n') + '\r\n');
}
function stats(meshes) {
  let tris = 0, area = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.position, ix = m.index;
    tris += ix.length / 3;
    for (let t = 0; t < ix.length; t += 3) area += Math.hypot(...triArea(p, ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3)) / 2;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
  }
  return { tris, area, bbox: [...lo, ...hi] };
}
function rawStats(tris) {
  let area = 0, n = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < tris.length; t += 9) {
    const a = Math.hypot(...triArea(tris, t, t + 3, t + 6)) / 2;
    area += a;
    // the reader drops triangles with two identical corners
    const same = (i, j) => tris[t + i] === tris[t + j] && tris[t + i + 1] === tris[t + j + 1] && tris[t + i + 2] === tris[t + j + 2];
    if (!same(0, 3) && !same(3, 6) && !same(0, 6)) n++;
    for (let c = 0; c < 9; c += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tris[t + c + k]); hi[k] = Math.max(hi[k], tris[t + c + k]); }
  }
  return { tris: n, area, bbox: [...lo, ...hi] };
}
/** per mesh face: planar? area, normal; plus structure checks */
function faceInfo(m) {
  const p = m.position, ix = m.index, out = [];
  let disconnected = 0, shared = 0;
  const owner = new Int32Array(p.length / 3).fill(-1);
  for (let f = 0; f < m.faceFirst.length; f++) {
    let area = 0; const n = [0, 0, 0]; let planar = true, n0 = null;
    const verts = new Set();
    for (let t = m.faceFirst[f]; t <= m.faceLast[f]; t++) {
      const cr = triArea(p, ix[t * 3] * 3, ix[t * 3 + 1] * 3, ix[t * 3 + 2] * 3), l = Math.hypot(...cr);
      for (let k = 0; k < 3; k++) { const v = ix[t * 3 + k]; verts.add(v); if (owner[v] >= 0 && owner[v] !== f) shared++; owner[v] = f; }
      if (!l) continue;
      area += l / 2; n[0] += cr[0]; n[1] += cr[1]; n[2] += cr[2];
      const u = cr.map((x) => x / l);
      if (!n0) n0 = u; else if (Math.abs(u[0] * n0[0] + u[1] * n0[1] + u[2] * n0[2]) < 0.99995) planar = false;
    }
    // edge-connectivity of the face's triangles
    const first = m.faceFirst[f], last = m.faceLast[f], cnt = last - first + 1;
    const byEdge = new Map(), parent = Int32Array.from({ length: cnt }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    for (let t = first; t <= last; t++) for (let e = 0; e < 3; e++) {
      const a = ix[t * 3 + e], b = ix[t * 3 + (e + 1) % 3], k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const o = byEdge.get(k);
      if (o === undefined) byEdge.set(k, t - first); else parent[find(o)] = find(t - first);
    }
    const roots = new Set(); for (let i = 0; i < cnt; i++) roots.add(find(i));
    if (roots.size > 1) disconnected++;
    const l = Math.hypot(...n);
    out.push({ area, planar, normal: l ? n.map((x) => x / l) : [0, 0, 1] });
  }
  return { faces: out, disconnected, shared };
}
const close = (a, b, rel = 1e-5) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const bboxClose = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-4 * Math.max(1, Math.abs(x)));

function testModel(occt, file) {
  const name = path.basename(file);
  const res = occt.ReadStepFile(new Uint8Array(fs.readFileSync(file)), PARAMS);
  if (!res.success) { check(false, `${name}: OpenCascade reads the STEP`); return; }
  const parts = sourceParts(res).filter((p) => p.tris.length); // empty solids give no part
  const all = new Float32Array(parts.reduce((n, p) => n + p.tris.length, 0));
  { let o = 0; for (const p of parts) { all.set(p.tris, o); o += p.tris.length; } }
  const want = rawStats(all);

  // binary, everything in one solid; the header starts with "solid" like SolidWorks writes it
  let t0 = Date.now();
  const bin = STL.read(binarySTL(all, 'solid exported by a CAD system'), `${name}.stl`);
  const tb = Date.now() - t0;
  const sb = stats(bin.meshes);
  check(bin.stats.binary && bin.meshes.length === 1 && bin.meshes[0].name === `${name}`, `${name} binary: detected as binary (header "solid ..."), one part named after the file`, `${bin.meshes.length} part(s) "${bin.meshes[0].name}"`);
  check(sb.tris === want.tris && close(sb.area, want.area) && bboxClose(sb.bbox, want.bbox), `${name} binary: triangles, area and bounding box equal the source`, `${sb.tris}/${want.tris} tris, area ${sb.area.toFixed(3)}/${want.area.toFixed(3)}, ${tb} ms`);

  // ASCII, one solid per part
  t0 = Date.now();
  const asc = STL.read(asciiSTL(parts), `${name}.stl`);
  const ta = Date.now() - t0;
  check(!asc.stats.binary && asc.meshes.length === parts.length && asc.meshes.every((m, i) => m.name === parts[i].name), `${name} ascii: one part per solid with its name`, `${asc.meshes.length}/${parts.length}, ${ta} ms`);
  const sa = stats(asc.meshes);
  check(sa.tris === want.tris && close(sa.area, want.area, 1e-5) && bboxClose(sa.bbox, want.bbox), `${name} ascii: triangles, area and bounding box equal the source`, `${sa.tris}/${want.tris} tris, area ${sa.area.toFixed(3)}/${want.area.toFixed(3)}`);
  check(JSON.stringify(asc.tree) === JSON.stringify({ name, meshes: parts.map((_, i) => i), children: [] }), `${name} ascii: tree lists every part`);

  // faces: a flat B-rep face is never split (its triangles all land in one planar STL face); faces sharing a plane
  // or meeting at a small angle may merge, so for a simple part each flat face comes back exactly
  let planarSrc = 0, matched = 0, whole = 0, stlFaces = 0, srcFaces = 0, disconnected = 0, shared = 0, ranges = true;
  let strictSrc = 0, strictWhole = 0, splitSrc = 0, splitFlat = 0, mergedCurved = 0, mergedFlat = 0;
  // a triangle by its exact corners (the ASCII round trip keeps float32 values exactly) in winding order, rotated to
  // start at the smallest: coincident triangles of opposite winding (a two-sided sheet) stay apart, and identical
  // ones are matched one occurrence each
  const key = (p, a, b, c) => {
    const s = [a, b, c].map((o) => `${p[o]},${p[o + 1]},${p[o + 2]}`);
    let k = 0;
    if (s[1] < s[k]) k = 1;
    if (s[2] < s[k]) k = 2;
    return `${s[k]}|${s[(k + 1) % 3]}|${s[(k + 2) % 3]}`;
  };
  let mismatched = 0;
  asc.meshes.forEach((m, i) => {
    const info = faceInfo(m);
    disconnected += info.disconnected; shared += info.shared;
    stlFaces += info.faces.length; srcFaces += parts[i].faces.length;
    for (let f = 0; f < m.faceFirst.length; f++) if (m.faceFirst[f] !== (f ? m.faceLast[f - 1] + 1 : 0) || m.faceLast[f] < m.faceFirst[f]) ranges = false;
    if (m.faceLast[m.faceLast.length - 1] !== m.index.length / 3 - 1) ranges = false;
    const faceOf = new Map(); // key -> output faces of its occurrences
    for (let f = 0; f < m.faceFirst.length; f++) for (let t = m.faceFirst[f]; t <= m.faceLast[f]; t++) {
      const k = key(m.position, m.index[t * 3] * 3, m.index[t * 3 + 1] * 3, m.index[t * 3 + 2] * 3);
      if (!faceOf.has(k)) faceOf.set(k, []);
      faceOf.get(k).push(f);
    }
    const take = (k) => { const l = faceOf.get(k); return l && l.length ? l.shift() : undefined; };
    const src = res.meshes.filter((x) => x.index.array.length)[i];
    const tr = parts[i].tris;
    (src.brep_faces || []).forEach((bf, j) => {
      const sf = parts[i].faces[j];
      if (!sf.normal) return;
      planarSrc++;
      const hit = new Set();
      for (let t = bf.first; t <= bf.last; t++) if (Math.hypot(...triArea(tr, t * 9, t * 9 + 3, t * 9 + 6))) hit.add(take(key(tr, t * 9, t * 9 + 3, t * 9 + 6)));
      if (hit.size === 1 && !hit.has(undefined)) whole++;
      if (sf.strict) { strictSrc++; if (hit.size === 1 && !hit.has(undefined)) strictWhole++; }
      const allFlat = !hit.has(undefined) && [...hit].every((f) => info.faces[f].planar);
      // categories (disjoint): split; whole and exact (the very face it maps to has its area and normal); whole but
      // merged into a larger flat face (coplanar or shallow neighbours); whole inside a curved face (beside a fillet)
      if (hit.size !== 1 || hit.has(undefined)) { splitSrc++; if (allFlat) splitFlat++; }
      else {
        const f = info.faces[[...hit][0]];
        if (!f.planar) mergedCurved++;
        else if (close(f.area, sf.area, 1e-4) && f.normal[0] * sf.normal[0] + f.normal[1] * sf.normal[1] + f.normal[2] * sf.normal[2] > 0.9999) matched++;
        else if (f.area > sf.area * (1 + 1e-4)) mergedFlat++; // it really covers more
        else mismatched++;
      }
    });
  });
  check(ranges, `${name}: faces are contiguous triangle ranges covering the mesh`);
  check(!disconnected && !shared, `${name}: each face is one connected piece; face borders have their own vertices`, `disconnected ${disconnected}, shared vertices ${shared}`);
  // a face flat within the plane angle is never split. One the viewer still calls flat (normals within 0.57°) but
  // warped beyond that, such as a two-triangle quad folded by 0.4°, is the same STL as two flat triangles at a
  // shallow angle and may come back as two faces, but only as flat ones (DXF keeps working). A small flat side
  // beside a fillet (under PLANE_SHARE of the smooth region) merges into the fillet's face, as in 0.0.7 (reported)
  check(strictWhole === strictSrc, `${name}: no B-rep face flat within ${STL.PLANE_ANGLE}° is split`, `${strictWhole}/${strictSrc}; ${stlFaces} STL faces vs ${srcFaces} B-rep faces`);
  check(splitFlat === splitSrc, `${name}: a flat B-rep face (0.57°) that is split comes back as flat pieces only`, `${splitFlat}/${splitSrc} split`);
  check(matched + mergedFlat + mergedCurved + splitSrc === planarSrc && !mismatched, `${name}: every flat B-rep face is accounted for`,
    `${planarSrc} flat: ${matched} exact, ${mergedFlat} merged into a larger flat face, ${mergedCurved} merged into a curved face beside a fillet, ${splitSrc} split, ${mismatched} unexplained`);
  if (/as1-oc-214/.test(name)) check(matched === planarSrc, `${name}: every flat face comes back exactly (area, normal)`, `${matched}/${planarSrc}`);
}

function synthetic() {
  // unit cube 10 mm, 12 triangles
  const P = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const cube = new Float32Array(T.flatMap((t) => t.flatMap((i) => P[i])));
  const c = STL.read(binarySTL(cube), 'cube.stl');
  const ci = faceInfo(c.meshes[0]);
  check(c.meshes[0].faceFirst.length === 6 && ci.faces.every((f) => f.planar && close(f.area, 100)), 'cube: 6 planar faces of 100 mm²', `${c.meshes[0].faceFirst.length} faces`);
  check(c.meshes[0].position.length / 3 === 24 && c.meshes[0].normal.every((x) => Math.abs(x) === 0 || Math.abs(x) === 1), 'cube: corners split per face, flat normals', `${c.meshes[0].position.length / 3} vertices`);
  // + a degenerate (two equal corners) and a zero-area (collinear) triangle
  const extra = new Float32Array([0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 5, 0, 0, 10, 0, 0]);
  const withDeg = new Float32Array(cube.length + extra.length); withDeg.set(cube); withDeg.set(extra, cube.length);
  const d = STL.read(binarySTL(withDeg), 'deg.stl');
  check(d.stats.dropped === 2 && d.meshes[0].index.length / 3 === 12 && d.meshes[0].faceFirst.length === 6, 'degenerate triangles: repeated-corner and collinear ones are left out of the mesh', `dropped ${d.stats.dropped}, ${d.meshes[0].index.length / 3} triangles, faces ${d.meshes[0].faceFirst.length}`);
  // round 24: a collinear facet along a crease, reaching 40 mm past it (or ending on it), changes nothing shown
  {
    const L = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], Vq = [[0, 0, 0], [0, 0, 5], [10, 0, 5], [10, 0, 0]];
    const base = [...L[0], ...L[2], ...L[1], ...L[0], ...L[3], ...L[2], ...Vq[0], ...Vq[1], ...Vq[2], ...Vq[0], ...Vq[2], ...Vq[3]];
    const sig = (r) => { const m = r.meshes[0], lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let k = 0; k < m.position.length; k++) { lo[k % 3] = Math.min(lo[k % 3], m.position[k]); hi[k % 3] = Math.max(hi[k % 3], m.position[k]); }
      return JSON.stringify({ tris: m.index.length / 3, verts: m.position.length / 3, faces: m.faceFirst.length, lo, hi }); };
    const ctl = sig(STL.read(binarySTL(new Float32Array(base)), 'c.stl'));
    const ext = sig(STL.read(binarySTL(new Float32Array([...base, 0, 0, 0, 10, 0, 0, 50, 0, 0])), 'e.stl'));
    const mid = sig(STL.read(binarySTL(new Float32Array([0, 0, 0, 10, 0, 0, 5, 0, 0, ...base])), 'm.stl'));
    check(ext === ctl && mid === ctl, 'a collinear facet along a crease (past it or ending on it) leaves triangles, faces and bounds unchanged', `${ctl} | ${ext} | ${mid}`);
  }
  // closed 64-sided cylinder r=5 h=20: side = one curved face, caps = 2 planar faces
  const N = 64, cyl = [];
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * 2 * Math.PI, a1 = ((i + 1) / N) * 2 * Math.PI;
    const p0 = [5 * Math.cos(a0), 5 * Math.sin(a0)], p1 = [5 * Math.cos(a1), 5 * Math.sin(a1)];
    cyl.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], 20, p0[0], p0[1], 0, p1[0], p1[1], 20, p0[0], p0[1], 20);
    cyl.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0, 0, 0, 20, p0[0], p0[1], 20, p1[0], p1[1], 20);
  }
  const cy = STL.read(asciiSTL([{ name: 'cyl', tris: new Float32Array(cyl) }]), 'cyl.stl');
  const yi = faceInfo(cy.meshes[0]);
  const curved = yi.faces.filter((f) => !f.planar), flat = yi.faces.filter((f) => f.planar);
  check(curved.length === 1 && flat.length === 2, 'cylinder: one curved side face + two planar caps', `${curved.length} curved, ${flat.length} planar`);
  // a coarse hexagonal prism keeps its 6 sides (60° creases)
  const hex = [];
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * 2 * Math.PI, a1 = ((i + 1) / 6) * 2 * Math.PI;
    const p0 = [5 * Math.cos(a0), 5 * Math.sin(a0)], p1 = [5 * Math.cos(a1), 5 * Math.sin(a1)];
    hex.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], 8, p0[0], p0[1], 0, p1[0], p1[1], 8, p0[0], p0[1], 8);
    hex.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0, 0, 0, 8, p0[0], p0[1], 8, p1[0], p1[1], 8);
  }
  const hx = STL.read(binarySTL(new Float32Array(hex)), 'hex.stl');
  check(hx.meshes[0].faceFirst.length === 8, 'hexagonal prism: 6 sides + 2 caps', `${hx.meshes[0].faceFirst.length} faces`);
  // flat sides meeting a fillet tangentially (every edge under 30°) stay faces of their own: two 20×10 strips
  // joined by an R1 quarter bend of 6 facets (round 20: 0.0.7 kept them, a plain smooth flood fill merged them)
  const bend = [];
  const bq = (a, b, c, d) => bend.push(...a, ...b, ...c, ...a, ...c, ...d);
  const arc = (k, y) => { const a = ((k / 6) * Math.PI) / 2; return [20 + Math.sin(a), y, 1 - Math.cos(a)]; };
  bq([0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]);
  for (let k = 0; k < 6; k++) bq(arc(k, 0), arc(k + 1, 0), arc(k + 1, 10), arc(k, 10));
  bq([21, 0, 1], [21, 0, 21], [21, 10, 21], [21, 10, 1]);
  const rf = faceInfo(STL.read(asciiSTL([{ name: 'rounded', tris: new Float32Array(bend) }]), 'rounded.stl').meshes[0]).faces;
  const rFlat = rf.filter((f) => f.planar).map((f) => f.area), rCurved = rf.filter((f) => !f.planar).map((f) => f.area);
  check(rFlat.length === 2 && rFlat.every((a) => close(a, 200, 1e-6)) && rCurved.length === 1 && close(rCurved[0], 15.66314, 1e-5),
    'flat sides next to a tangent fillet stay their own faces (2 × 200 mm² + the fillet)', JSON.stringify({ flat: rFlat, curved: rCurved }));
  // a quad flat only within the modelling tolerance (one corner 1 µm off, normals 0.01° apart) stays one face
  const warp = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0.001, 0, 0, 0, 10, 10, 0.001, 0, 10, 0]);
  const wf = STL.read(binarySTL(warp), 'warp.stl').meshes[0].faceFirst.length;
  check(wf === 1, 'a slightly warped two-triangle quad is one face, not two', `${wf} faces`);
  // ... but two real flat quads at a shallow angle stay two flat faces (round 21: 0.5° / 0.75°, as in 0.0.7)
  for (const deg of [0.5, 0.75]) {
    const a = (deg * Math.PI) / 180, q = [];
    const quad = (A, B, C, D) => q.push(...A, ...B, ...C, ...A, ...C, ...D);
    const far = [20 + 20 * Math.cos(a), 0, 20 * Math.sin(a)], farY = [far[0], 10, far[2]];
    quad([0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]);
    quad([20, 0, 0], far, farY, [20, 10, 0]);
    const sf = faceInfo(STL.read(binarySTL(new Float32Array(q)), 'shallow.stl').meshes[0]).faces;
    check(sf.length === 2 && sf.every((f) => f.planar && close(f.area, 200, 1e-4)), `two flat 20×10 faces meeting at ${deg}° stay two flat faces`, JSON.stringify(sf.map((f) => [f.planar, +f.area.toFixed(4)])));
  }
  // round 25: collinear facets neither join faces whose edges do not match (a T-junction: 0.0.7 gives two faces) nor
  // count against the edge cap (seven on a square's diagonal); an x = y plane needs no exact arithmetic
  {
    const sig = (q) => { const m = STL.read(binarySTL(new Float32Array(q)), 'x.stl').meshes[0]; return faceInfo(m).faces.map((f) => [f.planar, +f.area.toFixed(3)]); };
    const left = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]; // one edge (10,0)-(10,10)
    const right = [10, 0, 0, 20, 0, 0, 10, 5, 0, 10, 5, 0, 20, 0, 0, 20, 10, 0, 10, 5, 0, 20, 10, 0, 10, 10, 0]; // split at (10,5)
    const tj = JSON.stringify(sig([...left, ...right])), tjc = JSON.stringify(sig([...left, ...right, 10, 0, 0, 10, 10, 0, 10, 5, 0]));
    check(tj === tjc && tj === JSON.stringify([[true, 100], [true, 100]]), 'a T-junction with a collinear connector gives the same two flat faces as without it', `${tj} vs ${tjc}`);
    const sq = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0];
    const diag = []; for (let k = 1; k <= 7; k++) diag.push(0, 0, 0, 10, 10, 0, k * 1.25, k * 1.25, 0);
    const s0 = JSON.stringify(sig(sq)), s7 = JSON.stringify(sig([...sq, ...diag]));
    check(s0 === s7 && s0 === JSON.stringify([[true, 100]]), 'seven collinear facets on the diagonal of a square leave it one face', `${s0} vs ${s7}`);
    const N = 256, g = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const P = (a, b) => [a + 2 * b, a + 2 * b, a]; // the plane x = y with exact integer corners
      g.push(...P(i, j), ...P(i + 1, j), ...P(i + 1, j + 1), ...P(i, j), ...P(i + 1, j + 1), ...P(i, j + 1));
    }
    // count the exact (BigInt) conversions: stlfile.js looks BigInt up on the global object at each call
    const realBigInt = globalThis.BigInt;
    let conversions = 0;
    globalThis.BigInt = (x) => { conversions++; return realBigInt(x); };
    let gm, ms, control;
    try {
      const t0 = Date.now();
      gm = STL.read(binarySTL(new Float32Array(g)), 'xy.stl').meshes[0];
      ms = Date.now() - t0;
      const onPlane = conversions;
      const M = Math.fround(1e17);
      STL.read(binarySTL(new Float32Array([M, M, 0, 1, 0, 0, 2, 1, 0])), 'thin.stl'); // needs the exact path
      control = conversions - onPlane;
      conversions = onPlane;
    } finally { globalThis.BigInt = realBigInt; }
    check(gm.faceFirst.length === 1 && conversions === 0 && control > 0, `an x = y plane of ${2 * N * N} triangles is one face and reads without exact arithmetic`,
      `${ms} ms, ${conversions} BigInt conversions (extreme thin triangle: ${control})`);
  }
  // round 22: shallow flats with uneven support, far from the origin, warps under subdivision, extreme scales
  {
    const a = (0.75 * Math.PI) / 180, quadT = (q, A, B, C, D) => q.push(...A, ...B, ...C, ...A, ...C, ...D);
    const faces = (q, name = 'x.stl') => faceInfo(STL.read(binarySTL(new Float32Array(q)), name).meshes[0]).faces;
    const desc = (fs) => JSON.stringify(fs.map((f) => [f.planar, +f.area.toFixed(3)]));
    // a 20×10 quad and a triangle at 0.75°
    const qt = [];
    quadT(qt, [0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]);
    qt.push(20, 0, 0, 20 + 20 * Math.cos(a), 0, 20 * Math.sin(a), 20, 10, 0);
    const f1 = faces(qt);
    check(f1.length === 2 && f1.every((f) => f.planar), 'a flat quad and a flat triangle at 0.75° stay two flat faces', desc(f1));
    // an 82:18 split of two quads at 0.75° (the small side under PLANE_SHARE)
    const sm = [], w = 3.6, far = [41 + w * Math.cos(a), 0, w * Math.sin(a)];
    quadT(sm, [0, 0, 0], [41, 0, 0], [41, 20, 0], [0, 20, 0]);
    quadT(sm, [41, 0, 0], far, [far[0], 20, far[2]], [41, 20, 0]);
    const f2 = faces(sm);
    check(f2.length === 2 && f2.every((f) => f.planar), 'two flat quads at 0.75° in 82:18 stay two flat faces', desc(f2));
    // the passing 0.75° pair moved 1,000,000 mm along x: same faces as at the origin
    const off = [], X = 1e6, fa = [X + 20 + 20 * Math.cos(a), 0, 20 * Math.sin(a)];
    quadT(off, [X, 0, 0], [X + 20, 0, 0], [X + 20, 10, 0], [X, 10, 0]);
    quadT(off, [X + 20, 0, 0], fa, [fa[0], 10, fa[2]], [X + 20, 10, 0]);
    const f3 = faces(off);
    check(f3.length === 2 && f3.every((f) => f.planar), 'two flat quads at 0.75°, 1,000,000 mm from the origin, stay two flat faces', desc(f3));
    // a quad warped by 0.45°, as it is and with every triangle cut into 4: the same faces either way
    const W = [[0, 0, 0], [10, 0, 0], [10, 10, 0.055], [0, 10, 0]];
    const warp = [...W[0], ...W[1], ...W[2], ...W[0], ...W[2], ...W[3]];
    const refine = (q) => {
      const o = [];
      for (let t = 0; t < q.length; t += 9) {
        const P = [0, 1, 2].map((k) => q.slice(t + k * 3, t + k * 3 + 3)), M = (i, j) => P[i].map((x, k) => (x + P[j][k]) / 2);
        const ab = M(0, 1), bc = M(1, 2), ca = M(2, 0);
        o.push(...P[0], ...ab, ...ca, ...ab, ...P[1], ...bc, ...ca, ...bc, ...P[2], ...ab, ...bc, ...ca);
      }
      return o;
    };
    const wo = faces(warp), wr = faces(refine(warp));
    check(wo.length === wr.length && wo.every((f) => f.planar) && wr.every((f) => f.planar), 'a warped quad gives the same flat faces when its triangles are subdivided', `${desc(wo)} vs ${desc(wr)}`);
    // a 2×2 grid warped by a few hundredths of a degree is one flat face (as in 0.0.7)
    const gz = (x, y) => 0.0005 * Math.sin(x / 3) * Math.cos(y / 4), grid = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const x0 = i * 10, y0 = j * 10, x1 = x0 + 10, y1 = y0 + 10;
      quadT(grid, [x0, y0, gz(x0, y0)], [x1, y0, gz(x1, y0)], [x1, y1, gz(x1, y1)], [x0, y1, gz(x0, y1)]);
    }
    const f4 = faces(grid);
    check(f4.length === 1 && f4[0].planar && close(f4[0].area, 400, 1e-4), 'a lightly warped 2×2 grid is one flat face', desc(f4));
    // a thin triangle far from the origin is read the same in every corner order
    const thin = [[1e17, 1e17, 0], [0, 0, 0], [1, 0, 0]];
    const orders = [0, 1, 2].map((k) => { try { return STL.read(binarySTL(new Float32Array([0, 1, 2].flatMap((i) => thin[(i + k) % 3]))), 't.stl').meshes.length; } catch { return 0; } });
    check(orders.every((n) => n === 1), 'a valid thin triangle far from the origin opens in every corner order', JSON.stringify(orders));
    // normals of tiny and huge triangles point the right way and are finite
    const nrmOf = (tri) => { const m = STL.read(binarySTL(new Float32Array(tri)), 'n.stl').meshes[0]; return [...m.normal.slice(0, 3)]; };
    const tiny = nrmOf([0, 0, 0, 0, 1e-24, 0, 0, 0, 1e-24]), huge = nrmOf([0, 0, 0, 0, 1e20, 0, 0, 0, 1e20]);
    check(Math.abs(tiny[0] - 1) < 1e-6 && Math.abs(huge[0] - 1) < 1e-6 && [...tiny, ...huge].every(Number.isFinite), 'normals of 1e-24 and 1e20 sized triangles are +X and finite', JSON.stringify({ tiny, huge }));
  }
  // round 23: a thin strip along a 5° crease, a 0.02 mm ramp between two large flats, a pair far off in z, and an
  // extreme thin triangle whose area only exact arithmetic sees
  {
    const a5 = (5 * Math.PI) / 180, quadT = (q, A, B, C, D) => q.push(...A, ...B, ...C, ...A, ...C, ...D);
    const faces = (q) => faceInfo(STL.read(binarySTL(new Float32Array(q)), 'x.stl').meshes[0]).faces;
    const desc = (fs) => JSON.stringify(fs.map((f) => [f.planar, +f.area.toFixed(3)]));
    // base 1000 × 20 at z = 0, a second flat side rising at 5° from x = 1000; then the same with a 0.01 mm wide
    // coplanar strip cut off the inclined side along the crease
    const crease = (strip) => {
      const q = [], L = 500, up = (d) => [1000 + d * Math.cos(a5), 0, d * Math.sin(a5)], upY = (d) => { const u = up(d); return [u[0], 20, u[2]]; };
      quadT(q, [0, 0, 0], [1000, 0, 0], [1000, 20, 0], [0, 20, 0]);
      if (strip) { quadT(q, up(0), up(0.01), upY(0.01), upY(0)); quadT(q, up(0.01), up(L), upY(L), upY(0.01)); }
      else quadT(q, up(0), up(L), upY(L), upY(0));
      return faces(q);
    };
    const c0 = crease(false), c1 = crease(true);
    check(c0.length === 2 && c1.length === 2 && c1.every((f) => f.planar) && c0.every((f, i) => close(f.area, c1[i].area, 1e-9)),
      'cutting a 0.01 mm strip off a flat side at a 5° crease changes no face', `${desc(c0)} vs ${desc(c1)}`);
    // two 2 m flats joined by a 0.02 mm wide ramp at 5°
    const st = [], h = 0.02 * Math.sin(a5), x1 = 2000 + 0.02 * Math.cos(a5);
    quadT(st, [0, 0, 0], [2000, 0, 0], [2000, 20, 0], [0, 20, 0]);
    quadT(st, [2000, 0, 0], [x1, 0, h], [x1, 20, h], [2000, 20, 0]);
    quadT(st, [x1, 0, h], [x1 + 2000, 0, h], [x1 + 2000, 20, h], [x1, 20, h]);
    const fs3 = faces(st);
    check(fs3.length === 3 && fs3.every((f) => f.planar), 'two large flats joined by a 0.02 mm ramp at 5° stay three flat faces', desc(fs3));
    // the 0.75° pair 1,000,000 mm up the z axis
    const a = (0.75 * Math.PI) / 180, Z = 1e6, zq = [], fa = [20 + 20 * Math.cos(a), 0, Z + 20 * Math.sin(a)];
    quadT(zq, [0, 0, Z], [20, 0, Z], [20, 10, Z], [0, 10, Z]);
    quadT(zq, [20, 0, Z], fa, [fa[0], 10, fa[2]], [20, 10, Z]);
    const fz = faces(zq);
    check(fz.length === 2 && fz.every((f) => f.planar), 'two flat quads at 0.75°, 1,000,000 mm up the z axis, stay two flat faces', desc(fz));
    // (M, M, 0), (1, 0, 0), (2, 1, 0) with M = 1e17 in float32: area exactly 0.5, in both windings
    const M = Math.fround(1e17), ti = [[M, M, 0], [1, 0, 0], [2, 1, 0]];
    const opens = [false, true].flatMap((rev) => [0, 1, 2].map((k) => {
      const order = rev ? [2, 1, 0] : [0, 1, 2];
      try { return STL.read(binarySTL(new Float32Array(order.flatMap((i) => ti[(i + k) % 3]))), 't.stl').meshes.length; } catch { return 0; }
    }));
    let soupOk = true; try { STL.soup(binarySTL(new Float32Array(ti.flat()))); } catch { soupOk = false; }
    check(opens.every((n) => n === 1) && soupOk, 'an extreme thin triangle with a real area opens in every corner order and winding', JSON.stringify(opens));
  }
  // many triangles on one edge (stacked duplicates): memory and time stay linear, every triangle still shows
  {
    const N = 20000, dup = new Float32Array(N * 9);
    for (let i = 0; i < N; i++) dup.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
    const t0 = Date.now(), before = process.memoryUsage().arrayBuffers;
    const dr = STL.read(binarySTL(dup), 'dup.stl');
    const ms = Date.now() - t0, mb = (process.memoryUsage().arrayBuffers - before) / 1e6;
    check(dr.stats.triangles === N && dr.meshes[0].index.length === N * 3 && ms < 3000 && mb < 100, '20,000 stacked copies of one triangle: read in linear memory and time', `${ms} ms, ${mb.toFixed(1)} MB`);
  }
  const bad = (bytes, re, msg) => { let e = null; try { STL.read(bytes, 'x.stl'); } catch (x) { e = x; } check(!!e && re.test(e.message), msg, e ? e.message : 'no error'); };
  // Codex round 16 cases
  const enc = (t) => new TextEncoder().encode(t);
  const facet = (v) => `facet normal 0 0 0\n outer loop\n${v.map((p) => `  vertex ${p.join(' ')}`).join('\n')}\n endloop\nendfacet\n`;
  const T1 = [[0, 0, 0], [1, 0, 0], [0, 1, 0]], T2 = [[5, 0, 0], [6, 0, 0], [5, 1, 0]];
  const un = STL.read(enc(`solid\n${facet(T1)}endsolid\n`), 'nameless.stl');
  check(un.meshes.length === 1 && un.meshes[0].name === 'nameless' && un.meshes[0].index.length === 3, 'ascii: an unnamed solid keeps its triangles (named after the file)', JSON.stringify(un.meshes.map((m) => m.name)));
  const mix = STL.read(enc(`solid a\n${facet(T1)}endsolid a\nsolid\n${facet(T2)}endsolid\n`), 'mix.stl');
  check(mix.meshes.length === 2 && mix.meshes[0].name === 'a' && mix.meshes[1].name === 'mix 2', 'ascii: named + unnamed solids both kept', JSON.stringify(mix.meshes.map((m) => m.name)));
  const noEnd = STL.read(enc(`solid x\n${facet(T1)}`), 'noend.stl');
  check(noEnd.meshes.length === 1, 'ascii: a missing endsolid after complete facets is accepted');
  const binHdr = (header, tris, extra = 0) => { const b = binarySTL(tris, header); const o = new Uint8Array(b.length + extra); o.set(b); return o; };
  const one = new Float32Array(T1.flat());
  check(STL.read(binHdr('solid facet binary header', one, 1), 'b.stl').stats.binary, 'binary: a "solid ... facet" header with trailing bytes is still binary');
  check(STL.read(binHdr('solid facet binary header', one), 'b.stl').stats.binary, 'binary: a "solid ... facet" header with the exact size is binary');
  // Codex round 17: UTF-8 names (with and without BOM), binary bodies without control bytes + trailing bytes
  const kr = STL.read(enc(`solid 브래킷\n${facet(T1)}endsolid 브래킷\n`), 'k.stl');
  check(kr.meshes[0].name === '브래킷', 'ascii: UTF-8 solid name kept', kr.meshes[0].name);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(`solid 브래킷\n${facet(T1)}endsolid 브래킷\n`)]);
  const kb = STL.read(bom, 'k.stl');
  check(!kb.stats.binary && kb.meshes[0].name === '브래킷' && kb.meshes[0].index.length === 3, 'ascii: UTF-8 BOM accepted', kb.meshes[0].name);
  const nc = Buffer.alloc(84 + 50 + 1); nc.write('solid exported colored mesh', 0, 'latin1'); nc.writeUInt32LE(1, 80);
  [0x3f303030, 0x3f303030, 0x3f303030, 0x3f403030, 0x3f303030, 0x3f303030, 0x3f303030, 0x3f403030, 0x3f303030].forEach((b, k) => nc.writeUInt32LE(b, 96 + k * 4));
  nc.writeUInt32LE(0x3f303030, 84); nc.writeUInt32LE(0x3f303030, 88); nc.writeUInt32LE(0x3f303030, 92); nc.writeUInt16LE(0xffff, 132);
  const ncr = STL.read(new Uint8Array(nc), 'nc.stl');
  check(ncr.stats.binary && ncr.meshes[0].index.length === 3, 'binary: "solid" header, no control bytes in the body, trailing byte', `binary ${ncr.stats.binary}`);
  // Codex round 18: "vertex" text inside a binary body / header never replaces the real triangles
  const vb = Buffer.alloc(84 + 3 * 50 + 1); vb.write('solid binary mesh', 0, 'latin1'); vb.writeUInt32LE(3, 80);
  for (let t = 0; t < 3; t++) {
    const o = 84 + t * 50;
    vb.write(['vertex 0 0 0', 'vertex 1 0 0', 'vertex 0 1 0'][t], o, 'latin1');
    [10 + t * 10, 0, 0, 20 + t * 10, 0, 0, 10 + t * 10, 10, 0].forEach((v, k) => vb.writeFloatLE(v, o + 12 + k * 4));
    vb[o + 12] = 0x0a;
  }
  const vr = STL.read(new Uint8Array(vb), 'v.stl');
  check(vr.stats.binary && vr.meshes[0].index.length === 9, 'binary: "vertex" text inside the body is not read as ASCII', `binary ${vr.stats.binary}, ${vr.meshes[0].index.length / 3} tris`);
  const hb = Buffer.alloc(84 + 50 + 1); hb.write('solid h\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n', 0, 'latin1'); hb.writeUInt32LE(1, 80);
  [0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, k) => hb.writeFloatLE(v, 96 + k * 4));
  const hr = STL.read(new Uint8Array(hb), 'h.stl');
  check(hr.stats.binary && Math.abs(Math.max(...hr.meshes[0].position) - 10) < 1e-6, 'binary: an ASCII triangle written in the 80-byte header is ignored', `binary ${hr.stats.binary}`);
  // a zero-area triangle between two faces at 90° must not join them, in any file order
  const A = [0, 0, 0], Bp = [1, 0, 0], E = [2, 0, 0], C = [0, 1, 0], Z = [0, 0, 1];
  const tri3 = [[A, Bp, E], [A, Bp, C], [A, E, Z]];
  const orders = [[0, 1, 2], [1, 0, 2], [2, 1, 0], [0, 2, 1]].map((o) => STL.read(binarySTL(new Float32Array(o.flatMap((i) => tri3[i].flat()))), 'z.stl').meshes[0].faceFirst.length);
  check(orders.every((n) => n === 2), 'zero-area triangle never bridges a 90° crease (any order)', JSON.stringify(orders));
  // a 64,000-triangle fan (all sharing the center vertex) segments in linear time
  const fanN = 64000, fan = new Float32Array(fanN * 9);
  for (let i = 0; i < fanN; i++) {
    const a0 = (i / fanN) * 2 * Math.PI, a1 = ((i + 1) / fanN) * 2 * Math.PI;
    fan.set([0, 0, 0, 100 * Math.cos(a0), 100 * Math.sin(a0), 0, 100 * Math.cos(a1), 100 * Math.sin(a1), 0], i * 9);
  }
  const tf = Date.now(), fr = STL.read(binarySTL(fan), 'fan.stl'), ft = Date.now() - tf;
  check(fr.meshes[0].faceFirst.length === 1 && ft < 2000, 'a 64,000-triangle fan is one face and reads quickly', `${ft} ms`);
  // errors
  bad(enc(`solid x\n${facet(T1)}facet normal 0 0 1\n outer loop\n  vertex 5 0 0\n  vertex 6 0 0\n endloop\nendfacet\nendsolid x\n`), /3개가 아닌 facet/, 'ascii: a facet with 2 vertices is rejected (not silently dropped)');
  bad(enc(`solid x\n${facet(T1)}facet normal 0 0 1\n outer loop\n  vertex 5 0 0\n  vertex 6 0 0\n  vertex 5 1 0\n  vertex 7 7 7\n endloop\nendfacet\nendsolid x\n`), /3개가 아닌 facet/, 'ascii: a facet with 4 vertices is rejected');
  bad(enc(`solid x\n${facet(T1)}facet normal 0 0 1\n outer loop\n  vertex 5 0 0\n  vertex 6 0 0\n`), /3개가 아닌 facet/, 'ascii: a file cut inside a facet is rejected');
  const trunc = binarySTL(cube).slice(0, 84 + 50 * 5 + 10);
  bad(trunc, /잘렸|해석|삼각형/, 'truncated binary rejected with a message');
  bad(new TextEncoder().encode('solid x\n facet normal 0 0 1\n outer loop\n vertex 0 0 abc\n'), /숫자/, 'non-numeric ASCII vertex rejected with a message');
  bad(new TextEncoder().encode('solid empty\nendsolid empty\n'), /삼각형이 없/, 'empty STL rejected with a message');
  bad(new Uint8Array(0), /삼각형이 없/, 'empty file rejected with a message');
  bad(binarySTL(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])), /삼각형이 없/, 'an STL of collinear (zero-area) triangles only is rejected, not shown as an empty part');
  { let e = null; try { STL.soup(binarySTL(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]))); } catch (x) { e = x; } check(!!e && /삼각형이 없/.test(e.message), 'URDF mesh: an STL with no surface is reported too', e ? e.message : 'no error'); }
  { const two = asciiSTL([{ name: 'line', tris: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]) }, { name: 'tri', tris: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
    const r2 = STL.read(two, 'two.stl'); check(r2.meshes.length === 1 && r2.meshes[0].name === 'tri' && r2.stats.dropped === 1, 'a solid with no surface is left out, the others open', JSON.stringify({ parts: r2.meshes.map((m) => m.name), dropped: r2.stats.dropped })); }
  const nan = cube.slice(); nan[4] = NaN;
  bad(binarySTL(nan), /NaN|무한/, 'NaN coordinates rejected with a message');
}

/** STL meshes referenced by a URDF go through the same parser (urdffile.js builds them in the link frame itself) */
async function urdfMeshes() {
  const URDF = require('../app/urdffile.js');
  const P = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((x) => x * 0.01)); // 10 mm cube in m
  const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const cube = new Float32Array(T.flatMap((t) => t.flatMap((i) => P[i])));
  const moved = cube.map((v, k) => (k % 3 === 0 ? v + 0.03 : v));
  const trailer = (b, n) => { const o = new Uint8Array(b.length + n); o.set(b); return o; };
  const nan = cube.slice(); nan[4] = NaN;
  const files = {
    'a.stl': trailer(binarySTL(cube, 'solid a exported by CAD'), 2), // binary, "solid" header, trailing bytes
    'b.stl': asciiSTL([{ name: 'b1', tris: cube }, { name: 'b2', tris: moved }]), // ASCII, two solids
    'c.stl': binarySTL(cube).slice(0, 84 + 50 * 5), // truncated
    'd.stl': binarySTL(nan),
  };
  const names = Object.keys(files);
  const urdf = `<robot name="r">${names.map((f, i) => `<link name="l${i}"><visual><geometry><mesh filename="package://r/meshes/${f}"/></geometry></visual></link>`).join('')}`
    + names.slice(1).map((_, i) => `<joint name="j${i + 1}" type="fixed"><parent link="l0"/><child link="l${i + 1}"/></joint>`).join('') + '</robot>';
  const r = await URDF.read(new TextEncoder().encode(urdf), 'r.urdf', async (ref) => { const b = files[ref.split('/').pop()]; return b ? b.slice().buffer : null; });
  const tris = (link) => r.meshes.filter((m) => m.link === link).reduce((n, m) => n + m.index.length / 3, 0);
  const warn = r.warnings.join(' | ');
  check(tris('l0') === 12, 'URDF mesh: binary STL with a "solid…" header and trailing bytes is read', `${tris('l0')} triangles`);
  check(tris('l1') === 24, 'URDF mesh: ASCII STL with two solids keeps the triangles of both', `${tris('l1')} triangles`);
  check(!tris('l2') && /c\.stl: .*잘렸/.test(warn), 'URDF mesh: a truncated STL is skipped with a warning, the robot still opens', warn);
  check(!tris('l3') && /d\.stl: .*NaN/.test(warn), 'URDF mesh: an STL with NaN coordinates is skipped with a warning', warn);
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) for (const f of ['as1-oc-214.stp', 'UM2_1546-A.STEP']) { const p = path.join(root, 'testfiles', f); if (fs.existsSync(p)) files.push(p); }
  synthetic();
  await urdfMeshes();
  const occt = await occtimportjs();
  for (const f of files) testModel(occt, f);
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})();
