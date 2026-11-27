/* STL reader (binary and ASCII).
 *
 * STL is a bare triangle soup: no faces, edges, units or (in the standard) colors. To make it behave like the
 * CAD formats in the viewer, the reader
 *  - welds identical corner positions into shared vertices and drops triangles without area (repeated or collinear
 *    corners: they would only show as stray lines and enter DXF outlines; 0.0.7 dropped them too),
 *  - groups triangles into "faces": connected triangles whose normals differ by at most FACE_ANGLE across their
 *    shared edge (flat sides and finely faceted curved surfaces each become one face, sharp creases split them);
 *    a large flat patch inside such a smooth region (a flat side meeting a fillet tangentially) stays a face of its own,
 *  - orders the triangles face by face (faceFirst/faceLast ranges, as the OCCT results have), duplicates the
 *    vertices on face borders and smooths normals only inside a face, so creases stay sharp.
 * Face borders then become the drawn edges, and face/edge/vertex picking, measuring and DXF work as for CAD.
 *
 * Units: STL has none; values are taken as millimeters (what almost every CAD exporter writes).
 * ASCII files with several "solid ... endsolid" blocks give one part per block.
 * soup() gives just the parsed triangles (same format detection and damage checks); urdffile.js uses it for the
 * STL meshes a URDF references and builds those meshes itself, in the link frame.
 * Works in a worker (self.STLFile) and in Node (module.exports).
 */
(function (G) {
  'use strict';

  const FACE_ANGLE = 30; // degrees
  const PLANE_SHARE = 0.2; // a flat patch this large within a curved region is a face of its own
  const PLANE_ANGLE = 0.26; // degrees: a triangle whose normal is this close to a plane's normal lies in it (as in 0.0.7)
  const MAX_EDGE_TRIS = 8; // an edge shared by more triangles than this joins none of them into a face
  const MAX_TRIANGLES = 50e6;

  // exact arithmetic on float32 values: every finite float32 times 2^149 is an integer (the smallest is 2^-149)
  const FSCALE = 2 ** 149, FSCALE2 = 2 ** 298;
  const exactInt = (x) => BigInt(x * FSCALE); // only for float32 values (the caller checks)
  /** one component of (s - o) x (e - o), exactly: (s_i - o_i)(e_j - o_j) - (s_j - o_j)(e_i - o_i) */
  function exactCross(p, o, s, e, i, j) {
    const oi = exactInt(p[o + i]), oj = exactInt(p[o + j]);
    const d = (exactInt(p[s + i]) - oi) * (exactInt(p[e + j]) - oj) - (exactInt(p[s + j]) - oj) * (exactInt(p[e + i]) - oi);
    return Number(d) / FSCALE2;
  }
  const SPLIT = 134217729; // 2^27 + 1, Dekker's splitter
  /** was d = a - b exact in doubles? (the error of Knuth's two-sum is 0) */
  const diffExact = (a, b, d) => { const bv = d - a, av = d - bv; return (a - av) + (-b - bv) === 0; };
  /** was x = a * b exact in doubles? (the error of Dekker's two-product is 0) */
  function prodExact(a, b, x) {
    let c = SPLIT * a;
    const ah = c - (c - a), al = a - ah;
    c = SPLIT * b;
    const bh = c - (c - b), bl = b - bh;
    return al * bl - (((x - ah * bh) - al * bh) - ah * bl) === 0;
  }
  /** component u_i v_j - u_j v_i of the cross product of u = s - o and v = e - o. When cancellation could have cost
   *  the double result its sign or its zero, it checks whether the four differences and two products were exact
   *  (then the subtraction is correctly rounded: a plane such as x = y), and only otherwise computes it exactly */
  function crossComp(p, o, s, e, i, j, ui, vj, uj, vi) {
    const x = ui * vj, y = uj * vi, r = x - y;
    // a product is 0 only when one of its differences is exactly 0 (distinct float32 values never differ by 0)
    if (!(x || y) || Math.abs(r) > 1e-14 * (Math.abs(x) + Math.abs(y))) return r;
    if (diffExact(p[s + i], p[o + i], ui) && diffExact(p[e + j], p[o + j], vj) && diffExact(p[s + j], p[o + j], uj)
      && diffExact(p[e + i], p[o + i], vi) && prodExact(ui, vj, x) && prodExact(uj, vi, y)) return r;
    return p instanceof Float32Array ? exactCross(p, o, s, e, i, j) : r;
  }
  const dist2 = (p, i, j) => (p[i] - p[j]) ** 2 + (p[i + 1] - p[j + 1]) ** 2 + (p[i + 2] - p[j + 2]) ** 2;
  /** cross product of a triangle's edges (twice its area, along its normal) into out, in doubles. It starts at the
   *  corner opposite the longest edge (the two short edges lose the least to cancellation; the winding stays the
   *  same), and a component's sign and zero are always exact, so zero means zero area. a, b, c are offsets into p
   *  (vertex index * 3), which holds float32 values. app/main.js triCross is the same for the viewer */
  function cross3(p, a, b, c, out) {
    const ab = dist2(p, a, b), bc = dist2(p, b, c), ca = dist2(p, c, a);
    let o = a, s = b, e = c;
    if (!(bc >= ab && bc >= ca)) { if (ca >= ab) { o = b; s = c; e = a; } else { o = c; s = a; e = b; } }
    const ux = p[s] - p[o], uy = p[s + 1] - p[o + 1], uz = p[s + 2] - p[o + 2];
    const vx = p[e] - p[o], vy = p[e + 1] - p[o + 1], vz = p[e + 2] - p[o + 2];
    out[0] = crossComp(p, o, s, e, 1, 2, uy, vz, uz, vy);
    out[1] = crossComp(p, o, s, e, 2, 0, uz, vx, ux, vz);
    out[2] = crossComp(p, o, s, e, 0, 1, ux, vy, uy, vx);
    return out;
  }

  /** -> { exact: header count matches the size, fits: the binary body fits, text: starts with "solid" (after a UTF-8 BOM / spaces) } */
  function probe(bytes) {
    const n = bytes.length >= 84 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) : 0;
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while (i < bytes.length && i < 1000 && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13)) i++;
    const text = String.fromCharCode(...bytes.subarray(i, i + 5)).toLowerCase() === 'solid';
    return { n, exact: bytes.length >= 84 && 84 + n * 50 === bytes.length, fits: n > 0 && 84 + n * 50 <= bytes.length, text };
  }
  /** a control byte (NUL, ...) other than tab / line breaks: never in a text STL, always somewhere in a binary one
   *  (at the latest in the triangle count, unless that has four non-zero bytes) */
  function hasControlByte(bytes) {
    for (let k = 0; k < bytes.length; k++) {
      const c = bytes[k];
      if (c < 9 || (c > 13 && c < 32) || c === 127) return true;
    }
    return false;
  }
  /** binary or ASCII. A binary header may itself start with "solid" (SolidWorks and others write that): such a file
   *  is binary when it has control bytes, and otherwise read as text first (binary only when the text has no triangles) */
  function parse(bytes) {
    const p = probe(bytes);
    if (p.exact) return { binary: true, solids: parseBinary(bytes) };
    if (p.text) {
      if (p.fits && hasControlByte(bytes)) return { binary: true, solids: parseBinary(bytes) };
      let solids = null, err = null;
      try { solids = parseAscii(bytes); } catch (e) { err = e; }
      if (solids && solids.length) return { binary: false, solids };
      if (p.fits) return { binary: true, solids: parseBinary(bytes) };
      if (err) throw err;
      return { binary: false, solids: [] };
    }
    if (p.n > 0 && !p.fits) throw new Error('STL 파일이 잘렸습니다 (삼각형 수와 파일 크기가 맞지 않음).');
    if (p.fits) return { binary: true, solids: parseBinary(bytes) }; // trailing bytes after a binary body
    return { binary: false, solids: [] };
  }
  const isBinary = (bytes) => parse(bytes).binary;

  /** -> [{ name, tris: Float32Array (9 per triangle) }] */
  function parseBinary(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (n > MAX_TRIANGLES) throw new Error(`STL 삼각형이 너무 많습니다 (${n.toLocaleString()}개).`);
    if (84 + n * 50 > bytes.length) throw new Error('STL 파일이 잘렸습니다 (삼각형 수와 파일 크기가 맞지 않음).');
    const tris = new Float32Array(n * 9);
    for (let t = 0, o = 84 + 12; t < n; t++, o += 50) {
      for (let k = 0; k < 9; k++) tris[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    return [{ name: '', tris }];
  }

  function parseAscii(bytes) {
    // UTF-8 (solid names in any language, optional BOM); files that are not valid UTF-8 are read byte by byte
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('latin1').decode(bytes); }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const solids = [];
    let cur = null, vals = [], count = 0;
    let inFacet = false, fv = 0; // vertices of the current facet
    const incomplete = () => new Error('STL 파일이 손상되었습니다 (꼭짓점이 3개가 아닌 facet이 있음).');
    const endFacet = () => { if (inFacet && fv !== 3) throw incomplete(); inFacet = false; };
    const close = () => {
      endFacet();
      if (vals.length % 9) throw incomplete();
      if (cur !== null && vals.length) solids.push({ name: cur, tris: Float32Array.from(vals) });
      vals = [];
    };
    const re = /\b(endsolid|solid|endfacet|facet|vertex)\b[ \t]*([^\r\n]*)/gi;
    let m;
    while ((m = re.exec(text))) {
      const kw = m[1].toLowerCase();
      if (kw === 'facet') { endFacet(); inFacet = true; fv = 0; continue; }
      if (kw === 'endfacet') { endFacet(); continue; }
      if (kw === 'vertex') {
        if (inFacet && ++fv > 3) throw incomplete();
        const p = m[2].trim().split(/\s+/);
        if (p.length < 3) throw new Error('STL 파일을 해석하지 못했습니다 (vertex 좌표 형식 오류).');
        for (let k = 0; k < 3; k++) {
          const v = Number(p[k]);
          if (!Number.isFinite(v)) throw new Error('STL 파일을 해석하지 못했습니다 (vertex 좌표가 숫자가 아님).');
          vals.push(v);
        }
        if (cur === null) cur = '';
        if (++count > MAX_TRIANGLES * 3) throw new Error('STL 삼각형이 너무 많습니다.');
      } else if (kw === 'solid') {
        close();
        cur = m[2].trim();
      } else {
        close();
        cur = null;
      }
    }
    close();
    return solids;
  }

  /** identical positions -> one vertex. -> { pos: Float32Array, idx: Uint32Array (3 per kept triangle) } */
  function weld(tris) {
    const nc = tris.length / 3;
    let cap = 1;
    while (cap < nc * 2) cap <<= 1;
    const table = new Int32Array(cap).fill(-1);
    const bits = new Uint32Array(tris.buffer, tris.byteOffset, tris.length);
    const pos = new Float32Array(nc * 3);
    const corner = new Uint32Array(nc);
    let nv = 0;
    for (let c = 0; c < nc; c++) {
      // -0 and +0 are the same point
      const x = tris[c * 3] === 0 ? 0 : bits[c * 3], y = tris[c * 3 + 1] === 0 ? 0 : bits[c * 3 + 1], z = tris[c * 3 + 2] === 0 ? 0 : bits[c * 3 + 2];
      let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
      h = (h ^ (h >>> 15)) & (cap - 1);
      for (;;) {
        const v = table[h];
        if (v < 0) {
          table[h] = nv;
          pos[nv * 3] = tris[c * 3]; pos[nv * 3 + 1] = tris[c * 3 + 1]; pos[nv * 3 + 2] = tris[c * 3 + 2];
          corner[c] = nv++;
          break;
        }
        if (pos[v * 3] === tris[c * 3] && pos[v * 3 + 1] === tris[c * 3 + 1] && pos[v * 3 + 2] === tris[c * 3 + 2]) { corner[c] = v; break; }
        h = (h + 1) & (cap - 1);
      }
    }
    // triangles with a repeated corner, or three collinear ones, carry no surface (they are left out entirely: as
    // face connectors they would join faces whose edges do not match, and their edges would show and enter DXF)
    const idx = new Uint32Array(nc);
    const cr = new Float64Array(3);
    let ni = 0;
    for (let t = 0; t < nc / 3; t++) {
      const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      cross3(pos, a * 3, b * 3, c * 3, cr);
      if (!(cr[0] || cr[1] || cr[2])) continue;
      idx[ni++] = a; idx[ni++] = b; idx[ni++] = c;
    }
    return { pos: pos.slice(0, nv * 3), idx: idx.slice(0, ni) };
  }

  /** triangles (all with an area) -> faces; returns the face id of each triangle.
   *  1. smooth regions: flood fill across edges whose normals turn by at most FACE_ANGLE.
   *  2. a flat region is one face. A curved one gives up its large flat patches (a flat side meeting a fillet
   *     tangentially: at least PLANE_SHARE of the region's area) and the rest splits into connected smooth pieces.
   *  A triangle lies in a patch's plane when its normal is within PLANE_ANGLE of the patch seed's, wherever the part
   *  is and however finely it is cut up. Any two members then differ by at most 2 x PLANE_ANGLE, inside the
   *  viewer's flat-face test (0.57°), so a patch always exports to DXF. */
  function segment(pos, idx) {
    const nt = idx.length / 3;
    // unit normals and areas
    const nrm = new Float64Array(nt * 3), area = new Float64Array(nt);
    const cr = new Float64Array(3);
    for (let t = 0; t < nt; t++) {
      cross3(pos, idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3, cr);
      const l = Math.hypot(cr[0], cr[1], cr[2]);
      if (l > 0) { nrm[t * 3] = cr[0] / l; nrm[t * 3 + 1] = cr[1] / l; nrm[t * 3 + 2] = cr[2] / l; area[t] = l / 2; }
    }
    // edges: (a, b) with a < b -> edge id, by open addressing on typed arrays (linear in the triangle count)
    let cap = 1;
    while (cap < nt * 6) cap <<= 1;
    const slot = new Int32Array(cap).fill(-1);
    const ea = new Uint32Array(nt * 3), eb = new Uint32Array(nt * 3), triEdge = new Uint32Array(nt * 3);
    let ne = 0;
    for (let k = 0; k < nt * 3; k++) {
      let a = idx[k], b = idx[k % 3 === 2 ? k - 2 : k + 1];
      if (a > b) { const x = a; a = b; b = x; }
      let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77);
      h = (h ^ (h >>> 15)) & (cap - 1);
      for (;;) {
        const e = slot[h];
        if (e < 0) { slot[h] = ne; ea[ne] = a; eb[ne] = b; triEdge[k] = ne++; break; }
        if (ea[e] === a && eb[e] === b) { triEdge[k] = e; break; }
        h = (h + 1) & (cap - 1);
      }
    }
    // edge -> its triangles (CSR)
    const eStart = new Uint32Array(ne + 1);
    for (let k = 0; k < nt * 3; k++) eStart[triEdge[k] + 1]++;
    for (let e = 0; e < ne; e++) eStart[e + 1] += eStart[e];
    const eTri = new Uint32Array(nt * 3);
    { const put = eStart.slice(0, ne); for (let k = 0; k < nt * 3; k++) eTri[put[triEdge[k]]++] = (k / 3) | 0; }
    // triangle -> triangles across its edges (CSR). Every triangle on a non-manifold edge counts, up to
    // MAX_EDGE_TRIS on one edge; an edge shared by more (stacked duplicates, a "book" of fins) connects none of
    // them, which keeps this list linear in size
    const nStart = new Uint32Array(nt + 1);
    for (let t = 0; t < nt; t++) {
      let c = 0;
      for (let k = t * 3; k < t * 3 + 3; k++) { const e = triEdge[k], m = eStart[e + 1] - eStart[e]; if (m <= MAX_EDGE_TRIS) c += m - 1; }
      nStart[t + 1] = nStart[t] + c;
    }
    const nbr = new Uint32Array(nStart[nt]);
    for (let t = 0, o = 0; t < nt; t++) {
      for (let k = t * 3; k < t * 3 + 3; k++) {
        const e = triEdge[k];
        if (eStart[e + 1] - eStart[e] > MAX_EDGE_TRIS) continue;
        for (let j = eStart[e]; j < eStart[e + 1]; j++) if (eTri[j] !== t) nbr[o++] = eTri[j];
      }
    }

    const cosMax = Math.cos((FACE_ANGLE * Math.PI) / 180), planeCos = Math.cos((PLANE_ANGLE * Math.PI) / 180);
    const dot = (t, u) => nrm[t * 3] * nrm[u * 3] + nrm[t * 3 + 1] * nrm[u * 3 + 1] + nrm[t * 3 + 2] * nrm[u * 3 + 2];
    const stack = new Int32Array(nt);
    /** smooth flood fill from seed over unlabelled triangles that allowed(u) accepts; labels them id */
    const smoothFill = (seed, id, label, allowed) => {
      label[seed] = id;
      let sp = 0;
      stack[sp++] = seed;
      while (sp) {
        const t = stack[--sp];
        for (let k = nStart[t]; k < nStart[t + 1]; k++) {
          const u = nbr[k];
          if (label[u] >= 0 || !allowed(u) || dot(t, u) < cosMax) continue;
          label[u] = id;
          stack[sp++] = u;
        }
      }
    };
    // 1. smooth regions
    const region = new Int32Array(nt).fill(-1);
    let nr = 0;
    for (let s = 0; s < nt; s++) if (region[s] < 0) smoothFill(s, nr++, region, () => true);
    const rStart = new Uint32Array(nr + 1);
    for (let t = 0; t < nt; t++) rStart[region[t] + 1]++;
    for (let r = 0; r < nr; r++) rStart[r + 1] += rStart[r];
    const rList = new Uint32Array(nt);
    { const put = rStart.slice(0, nr); for (let t = 0; t < nt; t++) rList[put[region[t]]++] = t; }

    // 2. faces
    const face = new Int32Array(nt).fill(-1);
    let nf = 0;
    const small = [];
    for (let r = 0; r < nr; r++) {
      const r0 = rStart[r], r1 = rStart[r + 1];
      let L = rList[r0], total = 0;
      for (let i = r0; i < r1; i++) { const t = rList[i]; total += area[t]; if (area[t] > area[L]) L = t; }
      // a flat region (every triangle in the plane of the largest) is one face
      let flat = true;
      for (let i = r0; i < r1 && flat; i++) if (dot(rList[i], L) < planeCos) flat = false;
      if (flat) { for (let i = r0; i < r1; i++) face[rList[i]] = nf; nf++; continue; }
      // flat patches, seeded from the largest triangles (their normals are the most accurate)
      const seeds = Array.from(rList.subarray(r0, r1)).sort((a, b) => area[b] - area[a]);
      small.length = 0;
      for (const s of seeds) {
        if (face[s] >= 0) continue;
        const id = nf++;
        const first = small.length;
        let pa = 0, sp = 0;
        face[s] = id; stack[sp++] = s; small.push(s);
        while (sp) {
          const t = stack[--sp];
          pa += area[t];
          for (let k = nStart[t]; k < nStart[t + 1]; k++) {
            const u = nbr[k];
            if (face[u] >= 0 || region[u] !== r || dot(u, s) < planeCos) continue;
            face[u] = id; stack[sp++] = u; small.push(u);
          }
        }
        if (pa >= total * PLANE_SHARE) small.length = first; // a face of its own
      }
      // small patches dissolve back into the smooth remainder
      for (const t of small) face[t] = -1;
      for (let i = r0; i < r1; i++) { const s = rList[i]; if (face[s] < 0) smoothFill(s, nf++, face, (u) => region[u] === r); }
    }
    // face ids in order of first appearance, no gaps (dissolved patches left some unused)
    const remap = new Int32Array(nf).fill(-1);
    let n = 0;
    for (let t = 0; t < nt; t++) { const f = face[t]; if (remap[f] < 0) remap[f] = n++; face[t] = remap[f]; }
    return { face, nf: n };
  }

  /** welded triangles -> viewer mesh: triangles sorted by face, vertices split on face borders, per-face smooth normals */
  function buildMesh(name, pos, idx) {
    const nt = idx.length / 3;
    const { face, nf } = segment(pos, idx);
    // counting sort of the triangles by face (stable: keeps the file order inside a face)
    const fStart = new Uint32Array(nf + 1);
    for (let t = 0; t < nt; t++) fStart[face[t] + 1]++;
    for (let f = 0; f < nf; f++) fStart[f + 1] += fStart[f];
    const order = new Uint32Array(nt);
    const put = fStart.slice(0, nf);
    for (let t = 0; t < nt; t++) order[put[face[t]]++] = t;

    const nvIn = pos.length / 3;
    const stamp = new Int32Array(nvIn).fill(-1), local = new Uint32Array(nvIn);
    let outV = 0;
    // count the vertices first (one per face a welded vertex is used in)
    for (let f = 0; f < nf; f++) {
      for (let s = fStart[f]; s < fStart[f + 1]; s++) {
        const t = order[s];
        for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k]; if (stamp[v] !== f) { stamp[v] = f; outV++; } }
      }
    }
    stamp.fill(-1);
    const position = new Float32Array(outV * 3), normal = new Float32Array(outV * 3);
    const acc = new Float64Array(outV * 3), cr = new Float64Array(3); // normals summed in doubles (tiny or huge parts)
    const index = new Uint32Array(nt * 3);
    const faceFirst = new Int32Array(nf), faceLast = new Int32Array(nf);
    let nv = 0;
    for (let f = 0; f < nf; f++) {
      faceFirst[f] = fStart[f]; faceLast[f] = fStart[f + 1] - 1;
      for (let s = fStart[f]; s < fStart[f + 1]; s++) {
        const t = order[s];
        // area-weighted normal of the triangle
        cross3(pos, idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3, cr);
        const nx = cr[0], ny = cr[1], nz = cr[2];
        for (let k = 0; k < 3; k++) {
          const v = idx[t * 3 + k];
          if (stamp[v] !== f) {
            stamp[v] = f; local[v] = nv;
            position[nv * 3] = pos[v * 3]; position[nv * 3 + 1] = pos[v * 3 + 1]; position[nv * 3 + 2] = pos[v * 3 + 2];
            nv++;
          }
          const o = local[v] * 3;
          acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz;
          index[s * 3 + k] = local[v];
        }
      }
    }
    for (let v = 0; v < nv; v++) {
      const o = v * 3, l = Math.hypot(acc[o], acc[o + 1], acc[o + 2]);
      if (l > 0 && Number.isFinite(l)) { normal[o] = acc[o] / l; normal[o + 1] = acc[o + 1] / l; normal[o + 2] = acc[o + 2] / l; } else normal[o + 2] = 1;
    }
    return { name, color: null, position, normal, index, colors: null, faceFirst, faceLast };
  }

  function checkFinite(tris) {
    for (let k = 0; k < tris.length; k++) if (!Number.isFinite(tris[k])) throw new Error('STL 파일에 잘못된 좌표(NaN/무한대)가 있습니다.');
  }
  /** at least one triangle with an area (a solid of degenerate triangles only, such as collinear corners, shows nothing) */
  function hasSurface(tris) {
    const cr = new Float64Array(3);
    for (let t = 0; t < tris.length; t += 9) {
      cross3(tris, t, t + 3, t + 6, cr);
      if (cr[0] || cr[1] || cr[2]) return true;
    }
    return false;
  }

  /** every triangle of the file in one soup (9 floats per triangle, file units): the meshes a URDF references */
  function soup(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const { solids } = parse(bytes);
    let n = 0;
    let surface = false;
    for (const s of solids) { checkFinite(s.tris); n += s.tris.length; if (!surface) surface = hasSurface(s.tris); }
    if (!surface) throw new Error('STL 파일에 표시할 삼각형이 없습니다.');
    if (solids.length === 1) return solids[0].tris;
    const out = new Float32Array(n);
    let o = 0;
    for (const s of solids) { out.set(s.tris, o); o += s.tris.length; }
    return out;
  }

  /** bytes -> { meshes, tree, stats } in the worker's result format (positions in mm) */
  function read(bytes, fileName = 'model.stl') {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const base = String(fileName).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'STL';
    const { binary, solids } = parse(bytes);
    const meshes = [];
    let inTris = 0, dropped = 0;
    for (const s of solids) {
      inTris += s.tris.length / 9;
      checkFinite(s.tris);
      const { pos, idx } = weld(s.tris);
      dropped += s.tris.length / 9 - idx.length / 3; // repeated or collinear corners
      if (!idx.length) continue; // no surface to show
      meshes.push(buildMesh(s.name, pos, idx));
    }
    if (!meshes.length) throw new Error('STL 파일에 표시할 삼각형이 없습니다.');
    meshes.forEach((m, i) => { if (!m.name) m.name = meshes.length === 1 ? base : `${base} ${i + 1}`; });
    const tree = { name: base, meshes: meshes.map((_, i) => i), children: [] };
    return { meshes, tree, stats: { binary, solids: solids.length, triangles: inTris, dropped, faces: meshes.reduce((n, m) => n + m.faceFirst.length, 0) } };
  }

  const API = { read, soup, isBinary, FACE_ANGLE, PLANE_ANGLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else G.STLFile = API;
})(typeof self !== 'undefined' ? self : globalThis);
