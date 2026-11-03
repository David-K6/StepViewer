/* StepViewer parse worker: runs OpenCascade (occt-import-js WASM) off the UI thread,
 * converts the result to typed arrays and extracts CAD edges (B-rep face boundaries). */
/* global occtimportjs */
importScripts('vendor/occt-import-js.js');

let occtPromise = null;
function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: (p) => 'vendor/' + p });
  return occtPromise;
}

const QUALITY = {
  draft: { linearDeflection: 0.003, angularDeflection: 0.8 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.5 },
  fine: { linearDeflection: 0.0003, angularDeflection: 0.25 },
};

// sRGB [0,1] -> linear byte (vertex colors are interpreted as linear by three.js)
const lin = (c) => Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));

function formatOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'igs' || ext === 'iges') return 'iges';
  if (ext === 'brep' || ext === 'brp') return 'brep';
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

onmessage = async (ev) => {
  const { id, name, buffer, quality } = ev.data;
  const t0 = performance.now();
  try {
    const occt = await getOcct();
    const tInit = performance.now();
    const q = QUALITY[quality] || QUALITY.normal;
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...q };
    const bytes = new Uint8Array(buffer);
    const fmt = formatOf(name);
    let res;
    if (fmt === 'iges') res = occt.ReadIgesFile(bytes, params);
    else if (fmt === 'brep') res = occt.ReadBrepFile(bytes, params);
    else res = occt.ReadStepFile(bytes, params);
    const tParse = performance.now();
    if (!res || !res.success) throw new Error('파일을 해석하지 못했습니다 (지원되지 않거나 손상된 파일).');

    const transfer = [];
    const meshes = res.meshes.map((m) => {
      const position = new Float32Array(m.attributes.position.array);
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const vCount = position.length / 3;
      const index = vCount < 65536 ? new Uint16Array(m.index.array) : new Uint32Array(m.index.array);
      const triCount = index.length / 3;
      const faces = m.brep_faces || [];
      // per-face colors -> vertex colors only when faces differ from the mesh color
      let colors = null;
      const base = m.color || null;
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
      const edges = extractEdges(position, index, faces, triCount);
      transfer.push(position.buffer, index.buffer, edges.buffer, faceFirst.buffer, faceLast.buffer);
      if (normal) transfer.push(normal.buffer);
      if (colors) transfer.push(colors.buffer);
      return { name: m.name || '', color: base, position, normal, index, colors, edges, faceFirst, faceLast };
    });
    const stripTree = (n) => ({ name: n.name || '', meshes: n.meshes || [], children: (n.children || []).map(stripTree) });
    const tree = stripTree(res.root);
    const tEnd = performance.now();
    postMessage({ id, ok: true, tree, meshes, timing: { init: tInit - t0, parse: tParse - tInit, post: tEnd - tParse } }, transfer);
  } catch (e) {
    postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
