/* StepViewer parse worker: runs OpenCascade (occt-import-js WASM) off the UI thread,
 * converts the result to typed arrays and extracts CAD edges (B-rep face boundaries). */
/* global occtimportjs */
// When started from a blob (see main.js), the page hands over blob URLs of the scripts and the WASM it
// prefetched, so new workers never depend on the local server still being reachable.
const ASSETS = self.__svAssets || { occt: 'vendor/occt-import-js.js', sw: 'swfile.js', xt: 'xtfile.js', wasm: null };
importScripts(ASSETS.occt, ASSETS.sw, ASSETS.xt);

let occtPromise = null;
function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: (p) => (ASSETS.wasm && /\.wasm$/.test(p) ? ASSETS.wasm : 'vendor/' + p) });
  return occtPromise;
}

const QUALITY = {
  draft: { linearDeflection: 0.003, angularDeflection: 0.8 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.5 },
  fine: { linearDeflection: 0.0003, angularDeflection: 0.25 },
};

// sRGB [0,1] -> linear byte (vertex colors are interpreted as linear by three.js)
const lin = (c) => Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
// OpenCascade reports colors in linear RGB; the viewer (like the CAD file) works in sRGB
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbColor = (c) => (Array.isArray(c) && c.length >= 3 ? c.slice(0, 3).map((x) => Math.min(1, Math.max(0, toSrgb(x)))) : null);

function formatOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'sldprt' || ext === 'sldasm') return 'solidworks';
  if (ext === 'igs' || ext === 'iges') return 'iges';
  if (ext === 'brep' || ext === 'brp') return 'brep';
  if (ext === 'x_t' || ext === 'xmt_txt') return 'parasolid';
  return 'step';
}

/** Boundary edges of each B-rep face's triangulation = the CAD edges of the part.
 *  Edges shared by two faces are emitted once; seam edges (both sides in the same face) are dropped. */
function extractEdges(pos, idx, faces, triCount) {
  // triangle -> face id
  const triFace = new Int32Array(triCount).fill(-1);
  if (faces && faces.length) {
    for (let f = 0; f < faces.length; f++) {
      const a = Math.max(0, faces[f].first), b = Math.min(triCount - 1, faces[f].last);
      for (let t = a; t <= b; t++) triFace[t] = f;
    }
  } else {
    triFace.fill(0);
  }
  const nV = pos.length / 3;
  const edgeCount = new Map(); // key (a*nV+b) -> count, per face
  const segs = [];
  let start = 0;
  while (start < triCount) {
    const f = triFace[start];
    let end = start;
    while (end + 1 < triCount && triFace[end + 1] === f) end++;
    edgeCount.clear();
    for (let t = start; t <= end; t++) {
      const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      for (let e = 0; e < 3; e++) {
        let a = e === 0 ? i0 : e === 1 ? i1 : i2;
        let b = e === 0 ? i1 : e === 1 ? i2 : i0;
        if (a > b) { const tmp = a; a = b; b = tmp; }
        const k = a * nV + b;
        edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      }
    }
    for (const [k, c] of edgeCount) {
      if (c === 1) segs.push(Math.floor(k / nV), k % nV, f);
    }
    start = end + 1;
  }
  // dedupe across faces by quantized endpoint positions
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = 1 / (diag * 1e-6);
  const vkey = (i) => `${Math.round(pos[i * 3] * q)},${Math.round(pos[i * 3 + 1] * q)},${Math.round(pos[i * 3 + 2] * q)}`;
  const seen = new Map(); // segKey -> {face, slot}
  const keep = new Uint8Array(segs.length / 3);
  for (let s = 0; s < segs.length; s += 3) {
    const ka = vkey(segs[s]), kb = vkey(segs[s + 1]);
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const prev = seen.get(key);
    const slot = s / 3;
    if (prev === undefined) { seen.set(key, { face: segs[s + 2], slot }); keep[slot] = 1; }
    else if (prev.face === segs[s + 2]) { keep[prev.slot] = 0; } // seam inside one face
  }
  let n = 0;
  for (let i = 0; i < keep.length; i++) n += keep[i];
  const out = new Float32Array(n * 6);
  let o = 0;
  for (let s = 0; s < segs.length; s += 3) {
    if (!keep[s / 3]) continue;
    const a = segs[s] * 3, b = segs[s + 1] * 3;
    out[o++] = pos[a]; out[o++] = pos[a + 1]; out[o++] = pos[a + 2];
    out[o++] = pos[b]; out[o++] = pos[b + 1]; out[o++] = pos[b + 2];
  }
  return out;
}

// ---- file requests to the main thread (assembly references that are not embedded) ----
const needs = new Map();
let needSeq = 0;
function requestFile(jobId, fileName) {
  return new Promise((resolve) => {
    const rid = ++needSeq;
    needs.set(rid, resolve);
    postMessage({ id: jobId, need: fileName, rid });
  });
}

/** occt result mesh -> our transferable mesh (positions in mm) */
function convertOcctMesh(m) {
  const position = new Float32Array(m.attributes.position.array);
  const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
  const vCount = position.length / 3;
  const index = vCount < 65536 ? new Uint16Array(m.index.array) : new Uint32Array(m.index.array);
  const faces = (m.brep_faces || []).map((f) => ({ ...f, color: srgbColor(f.color) }));
  // per-face colors -> vertex colors only when faces differ from the mesh color
  let colors = null;
  const base = srgbColor(m.color);
  const differs = faces.some((f) => f.color && (!base || f.color[0] !== base[0] || f.color[1] !== base[1] || f.color[2] !== base[2]));
  if (differs) {
    colors = new Uint8Array(vCount * 3);
    const fb = (base || [0.72, 0.75, 0.8]).map(lin);
    for (let v = 0; v < vCount; v++) { colors[v * 3] = fb[0]; colors[v * 3 + 1] = fb[1]; colors[v * 3 + 2] = fb[2]; }
    for (const f of faces) {
      if (!f.color) continue;
      const fc = f.color.map(lin);
      for (let t = f.first; t <= f.last; t++) {
        for (let k = 0; k < 3; k++) {
          const v = index[t * 3 + k];
          colors[v * 3] = fc[0]; colors[v * 3 + 1] = fc[1]; colors[v * 3 + 2] = fc[2];
        }
      }
    }
  }
  const faceFirst = new Int32Array(faces.length), faceLast = new Int32Array(faces.length);
  faces.forEach((f, i) => { faceFirst[i] = f.first; faceLast[i] = f.last; });
  return { name: m.name || '', color: base, position, normal, index, colors, faceFirst, faceLast };
}

/** add CAD edges + compact index, collect transferables */
function finish(meshes) {
  const transfer = [];
  for (const m of meshes) {
    if (m.index.length && m.position.length / 3 < 65536 && !(m.index instanceof Uint16Array)) m.index = Uint16Array.from(m.index);
    const faces = Array.from(m.faceFirst, (first, i) => ({ first, last: m.faceLast[i] }));
    m.edges = extractEdges(m.position, m.index, faces, m.index.length / 3);
    if (m.colors === undefined) m.colors = null;
    transfer.push(m.position.buffer, m.index.buffer, m.edges.buffer, m.faceFirst.buffer, m.faceLast.buffer);
    if (m.normal) transfer.push(m.normal.buffer);
    if (m.colors) transfer.push(m.colors.buffer);
  }
  return transfer;
}

/** OCCT meshes of the converted X_T -> one mesh per Parasolid body, named and grouped by the body names
 *  ("part__body" and "a.step-1/b.step-1/solid1" paths, as Onshape and others write them) */
function parasolidResult(res, conv, fileName) {
  const byKey = new Map(conv.bodies.map((b, i) => [b.key, { ...b, no: i + 1 }]));
  const meshes = [];
  const root = { name: fileName.replace(/\.[^.]+$/, ''), meshes: [], children: [] };
  const groups = new Map();
  const groupOf = (segs) => {
    let path = '', node = root;
    for (const s of segs) {
      path += '/' + s;
      let n = groups.get(path);
      if (!n) { n = { name: s, meshes: [], children: [] }; groups.set(path, n); node.children.push(n); }
      node = n;
    }
    return node;
  };
  const nodes = [];
  const walk = (n) => { if (byKey.has(n.name)) nodes.push(n); else for (const c of n.children || []) walk(c); };
  walk(res.root);
  for (const n of nodes) {
    const b = byKey.get(n.name);
    const parts = [];
    const collect = (x) => { for (const mi of x.meshes || []) parts.push(convertOcctMesh(res.meshes[mi])); for (const c of x.children || []) collect(c); };
    collect(n);
    if (!parts.length) continue;
    const m = parts.length === 1 ? parts[0] : mergeMeshes(parts);
    if (b.color) m.color = b.color.slice(0, 3);
    // "NONE" is the placeholder some writers use for unnamed bodies: number those within their group
    const raw = b.name ? b.name.split('__').flatMap((s) => s.split('/')).map((s) => s.trim()).filter(Boolean) : [];
    const named = raw.length && raw[raw.length - 1].toUpperCase() !== 'NONE';
    const groupSegs = (named ? raw.slice(0, -1) : raw).filter((s) => s.toUpperCase() !== 'NONE');
    const g = groupOf(groupSegs);
    m.name = named ? raw[raw.length - 1] : `바디 ${g.meshes.length + 1}`;
    g.meshes.push(meshes.length);
    meshes.push(m);
  }
  if (!meshes.length) throw new Error('X_T 파일의 형상을 표시하지 못했습니다.');
  return { meshes, tree: root };
}
/** several OCCT meshes of one body (one per shell) -> one mesh */
function mergeMeshes(list) {
  let nv = 0, ni = 0, nf = 0;
  for (const m of list) { nv += m.position.length; ni += m.index.length; nf += m.faceFirst.length; }
  const position = new Float32Array(nv), normal = list.every((m) => m.normal) ? new Float32Array(nv) : null;
  const index = new Uint32Array(ni), faceFirst = new Int32Array(nf), faceLast = new Int32Array(nf);
  const colors = list.some((m) => m.colors) ? new Uint8Array(nv) : null;
  let ov = 0, oi = 0, of = 0, ot = 0;
  for (const m of list) {
    position.set(m.position, ov);
    if (normal) normal.set(m.normal, ov);
    if (colors) {
      if (m.colors) colors.set(m.colors, ov);
      else { const c = (m.color || [0.72, 0.75, 0.8]).map(lin); for (let v = ov; v < ov + m.position.length; v += 3) { colors[v] = c[0]; colors[v + 1] = c[1]; colors[v + 2] = c[2]; } }
    }
    const base = ov / 3;
    for (let k = 0; k < m.index.length; k++) index[oi + k] = m.index[k] + base;
    for (let k = 0; k < m.faceFirst.length; k++) { faceFirst[of + k] = m.faceFirst[k] + ot; faceLast[of + k] = m.faceLast[k] + ot; }
    ov += m.position.length; oi += m.index.length; of += m.faceFirst.length; ot += m.index.length / 3;
  }
  return { name: list[0].name, color: list[0].color, position, normal, index, colors, faceFirst, faceLast };
}

async function readOcct(name, bytes, quality) {
  const occt = await getOcct();
  const q = QUALITY[quality] || QUALITY.normal;
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...q };
  const fmt = formatOf(name);
  let res;
  if (fmt === 'iges') res = occt.ReadIgesFile(bytes, params);
  else if (fmt === 'brep') res = occt.ReadBrepFile(bytes, params);
  else res = occt.ReadStepFile(bytes, params);
  if (!res || !res.success) throw new Error('파일을 해석하지 못했습니다 (지원되지 않거나 손상된 파일).');
  return res;
}

onmessage = async (ev) => {
  if (ev.data.needReply) {
    const r = needs.get(ev.data.needReply);
    needs.delete(ev.data.needReply);
    if (r) r(ev.data.buffer || null);
    return;
  }
  const { id, name, buffer, quality, noCache } = ev.data;
  const t0 = performance.now();
  try {
    const bytes = new Uint8Array(buffer);
    if (formatOf(name) === 'solidworks') {
      const readStep = async (buf, sname) => {
        const res = await readOcct(sname, new Uint8Array(buf), quality);
        return res.meshes.map(convertOcctMesh);
      };
      const r = await SWFile.read(bytes, name, (fname) => requestFile(id, fname), { readStep, noCache });
      const tParse = performance.now();
      const transfer = finish(r.meshes);
      const tEnd = performance.now();
      postMessage({ id, ok: true, tree: r.tree, meshes: r.meshes, missing: r.missing, usedSiblings: r.usedSiblings, invalidFaces: r.invalidFaces || 0,
        timing: { init: 0, parse: tParse - t0, post: tEnd - tParse } }, transfer);
      return;
    }
    if (formatOf(name) === 'parasolid') {
      await getOcct();
      const tInit = performance.now();
      const conv = XTFile.toStep(bytes);
      const res = await readOcct(name.replace(/\.[^.]+$/, '') + '.step', new TextEncoder().encode(conv.step), quality);
      const tParse = performance.now();
      const { meshes, tree } = parasolidResult(res, conv, name);
      const transfer = finish(meshes);
      const tEnd = performance.now();
      const st = conv.stats;
      postMessage({ id, ok: true, tree, meshes, xtSkipped: { faces: st.skippedFaces, bodies: st.failedBodies || 0 }, timing: { init: tInit - t0, parse: tParse - tInit, post: tEnd - tParse } }, transfer);
      return;
    }
    await getOcct();
    const tInit = performance.now();
    const res = await readOcct(name, bytes, quality);
    const tParse = performance.now();
    const meshes = res.meshes.map(convertOcctMesh);
    const transfer = finish(meshes);
    const stripTree = (n) => ({ name: n.name || '', meshes: n.meshes || [], children: (n.children || []).map(stripTree) });
    const tree = stripTree(res.root);
    const tEnd = performance.now();
    postMessage({ id, ok: true, tree, meshes, timing: { init: tInit - t0, parse: tParse - tInit, post: tEnd - tParse } }, transfer);
  } catch (e) {
    postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
