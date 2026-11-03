/* SolidWorks SLDPRT / SLDASM reader (SolidWorks 2015+ container format).
 *
 * Reads the display tessellation SolidWorks stores in the file, not the Parasolid B-rep:
 *  - container: sections "14 00 06 00 08 00 | crc | compSize | uncompSize | nameLen | name (nibble-swapped) | raw deflate"
 *  - part:      Contents/DisplayLists       -> per-face triangle strips (float32 xyz in meters + normals)
 *  - assembly:  swXmlContents/COMPINSTANCETREE (component tree + 4x4 column-major transforms)
 *               FaceTessellations/Directory + FaceTessellations/<stream> (per-component face strips, component-local)
 * Faces are records whose header ends with "96 ?? 20 00" + 16 zero bytes right before the strip-length array;
 * other strip blocks (cosmetic threads etc.) are ignored.
 *
 * Works in a worker (self.SWFile) and in Node (module.exports). Needs DecompressionStream('deflate-raw').
 */
(function (G) {
  'use strict';

  const td8 = new TextDecoder('utf-8');
  const td16 = new TextDecoder('utf-16le');

  async function inflateRaw(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ------------------------------------------------------------------ container
  class Container {
    constructor(u8) {
      this.u8 = u8;
      this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.entries = new Map(); // name -> [{off, comp, unc}]
      this._scan();
    }
    static isOle(u8) { return u8.length > 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0; }
    _scan() {
      const u8 = this.u8, dv = this.dv, n = u8.length;
      for (let i = 0; i + 26 <= n; i++) {
        if (u8[i] !== 0x14 || u8[i + 1] !== 0 || u8[i + 2] !== 6 || u8[i + 3] !== 0 || u8[i + 4] !== 8 || u8[i + 5] !== 0) continue;
        // +6 u32 (flags/stamp), +10 u32 crc, +14 compSize, +18 uncompSize, +22 nameLen, +26 name
        const comp = dv.getUint32(i + 14, true), unc = dv.getUint32(i + 18, true), nl = dv.getUint32(i + 22, true);
        const start = i + 26 + nl;
        if (nl === 0 || nl > 1024 || start + comp > n) continue;
        const nb = new Uint8Array(nl);
        let ok = true;
        for (let k = 0; k < nl; k++) {
          const b = u8[i + 26 + k];
          const c = ((b << 4) | (b >> 4)) & 0xff;
          if (c < 0x20) { ok = false; break; }
          nb[k] = c;
        }
        if (!ok) continue;
        const name = td8.decode(nb);
        if (!this.entries.has(name)) this.entries.set(name, []);
        this.entries.get(name).push({ off: start, comp, unc });
      }
    }
    names() { return [...this.entries.keys()]; }
    has(name) { return this.entries.has(name); }
    /** Inflate a section by exact name. Duplicate/bogus headers exist, so candidates are verified by size. */
    async get(name) {
      const cands = (this.entries.get(name) || []).slice().sort((a, b) => b.comp - a.comp);
      for (const c of cands) {
        if (c.unc === 0) continue;
        try {
          const out = await inflateRaw(this.u8.subarray(c.off, c.off + c.comp));
          if (out.length === c.unc) return out;
        } catch { /* not this one */ }
      }
      return null;
    }
  }

  // ------------------------------------------------------------------ face strip blocks
  /** Scan [lo,hi) of a tessellation stream for face records.
   *  Returns [{strips:Uint32Array, V:Float32Array (m), N:Float32Array|null}] */
  function scanFaces(u8, lo = 0, hi = u8.length, isFace = isFaceRecord) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const faces = [];
    const u32 = (o) => dv.getUint32(o, true);
    let i = Math.max(lo, 20);
    while (i + 16 <= hi) {
      // strip-length array header: [4, 8, 2, k]
      if (u8[i] === 4 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0 && u8[i + 4] === 8 && u8[i + 8] === 2 &&
          u32(i + 4) === 8 && u32(i + 8) === 2) {
        const k = u32(i + 12);
        const j = i + 16 + 4 * k;
        if (k > 0 && k < 1e6 && j + 16 <= hi) {
          let sum = 0, okS = true;
          for (let q = 0; q < k; q++) { const s = u32(i + 16 + 4 * q); if (s < 3 || s > 1e7) { okS = false; break; } sum += s; }
          if (okS && u32(j) === 12 && u32(j + 4) === 100 && u32(j + 8) === 2 && u32(j + 12) === sum && j + 16 + 12 * sum <= hi) {
            const vOff = j + 16;
            let end = vOff + 12 * sum;
            let nOff = -1;
            if (end + 16 <= hi && u32(end) === 12 && u32(end + 4) === 100 && u32(end + 8) === 2 && u32(end + 12) === sum && end + 16 + 12 * sum <= hi) {
              nOff = end + 16; end = nOff + 12 * sum;
            }
            if (isFace(u8, i)) {
              const strips = new Uint32Array(k);
              for (let q = 0; q < k; q++) strips[q] = u32(i + 16 + 4 * q);
              const V = new Float32Array(3 * sum);
              let N = nOff >= 0 ? new Float32Array(3 * sum) : null;
              let bad = false, badN = false;
              for (let q = 0; q < 3 * sum; q++) {
                const v = dv.getFloat32(vOff + 4 * q, true);
                if (!(Math.abs(v) < MAX_COORD)) bad = true; // NaN / Inf / absurd -> corrupted
                V[q] = v;
                if (N) { const n = dv.getFloat32(nOff + 4 * q, true); if (!(Math.abs(n) <= 1.01)) badN = true; N[q] = n; }
              }
              if (bad) faces.invalid = (faces.invalid || 0) + 1;
              else faces.push({ strips, V, N: badN ? null : N });
            }
            i = end;
            continue;
          }
        }
      }
      i++;
    }
    return faces;
  }
  /** Part DisplayLists are an MFC archive: the first face record follows the class declaration
   *  "uoTempFaceTessData_c", later ones start with that class's u16 tag (0x8000|index). The record
   *  header between the tag and the strip array has a fixed length per file version. */
  const FACE_CLASS = new TextEncoder().encode('uoTempFaceTessData_c');
  function dlFacePredicate(u8) {
    const at = indexOf(u8, FACE_CLASS);
    if (at < 0) return isFaceRecord;
    const nameEnd = at + FACE_CLASS.length;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // first strip header after the declaration
    let first = -1;
    for (let i = nameEnd; i < Math.min(u8.length - 16, nameEnd + 512); i++) {
      if (dv.getUint32(i, true) === 4 && dv.getUint32(i + 4, true) === 8 && dv.getUint32(i + 8, true) === 2) { first = i; break; }
    }
    if (first < 0) return isFaceRecord;
    const H = first - nameEnd;
    // the class tag: most frequent u16 with the high bit set found at (block - H - 2)
    const counts = new Map();
    for (const o of stripOffsets(u8)) {
      if (o - H - 2 < 0) continue;
      const t = dv.getUint16(o - H - 2, true);
      if (t & 0x8000) counts.set(t, (counts.get(t) || 0) + 1);
    }
    let tag = -1, best = 0;
    for (const [t, c] of counts) if (c > best) { best = c; tag = t; }
    return (buf, o) => o === first || (o - H - 2 >= 0 && dv.getUint16(o - H - 2, true) === tag);
  }
  function stripOffsets(u8) {
    const out = [];
    scanFaces(u8, 0, u8.length, (buf, o) => { out.push(o); return false; });
    return out;
  }
  const MAX_COORD = 1e4; // meters
  function isFaceRecord(u8, o) {
    // flags byte seen as 0x96 / 0x94; other strip blocks (cosmetic threads...) are not followed by 16 zero bytes
    if (o < 20 || (u8[o - 20] & 0x80) === 0 || u8[o - 18] !== 0x20 || u8[o - 17] !== 0) return false;
    for (let q = o - 16; q < o; q++) if (u8[q] !== 0) return false;
    return true;
  }

  /** Faces -> indexed mesh in component-local mm. Vertices are welded per face so the
   *  face-boundary edge extraction works; winding follows the stored normals. */
  function facesToMesh(faces) {
    let nIn = 0, nTri = 0;
    for (const f of faces) { nIn += f.V.length / 3; for (const s of f.strips) nTri += s - 2; }
    const pos = new Float32Array(nIn * 3), nor = new Float32Array(nIn * 3);
    const idx = new Uint32Array(nTri * 3);
    const faceFirst = new Int32Array(faces.length), faceLast = new Int32Array(faces.length);
    const f32 = new Float32Array(3), u32v = new Uint32Array(f32.buffer);
    let nv = 0, nt = 0;
    const remap = [];
    faces.forEach((f, fi) => {
      const cnt = f.V.length / 3;
      const weld = new Map();
      remap.length = cnt;
      for (let v = 0; v < cnt; v++) {
        f32[0] = f.V[3 * v]; f32[1] = f.V[3 * v + 1]; f32[2] = f.V[3 * v + 2];
        const key = u32v[0] + ',' + u32v[1] + ',' + u32v[2];
        let id = weld.get(key);
        if (id === undefined) {
          id = nv++;
          weld.set(key, id);
          pos[3 * id] = f.V[3 * v] * 1000; pos[3 * id + 1] = f.V[3 * v + 1] * 1000; pos[3 * id + 2] = f.V[3 * v + 2] * 1000;
          if (f.N) { nor[3 * id] = f.N[3 * v]; nor[3 * id + 1] = f.N[3 * v + 1]; nor[3 * id + 2] = f.N[3 * v + 2]; }
        }
        remap[v] = id;
      }
      faceFirst[fi] = nt;
      let o = 0;
      for (const s of f.strips) {
        for (let t = 0; t < s - 2; t++) {
          let a = o + t, b = o + t + 1, c = o + t + 2;
          if (t & 1) { const tmp = b; b = c; c = tmp; }
          const A = remap[a], B = remap[b], C = remap[c];
          if (A === B || B === C || A === C) continue;
          // orient by stored normals
          if (f.N) {
            const ux = f.V[3 * b] - f.V[3 * a], uy = f.V[3 * b + 1] - f.V[3 * a + 1], uz = f.V[3 * b + 2] - f.V[3 * a + 2];
            const vx = f.V[3 * c] - f.V[3 * a], vy = f.V[3 * c + 1] - f.V[3 * a + 1], vz = f.V[3 * c + 2] - f.V[3 * a + 2];
            const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
            const sx = f.N[3 * a] + f.N[3 * b] + f.N[3 * c], sy = f.N[3 * a + 1] + f.N[3 * b + 1] + f.N[3 * c + 1], sz = f.N[3 * a + 2] + f.N[3 * b + 2] + f.N[3 * c + 2];
            if (gx * sx + gy * sy + gz * sz < 0) { idx[3 * nt] = A; idx[3 * nt + 1] = C; idx[3 * nt + 2] = B; nt++; continue; }
          }
          idx[3 * nt] = A; idx[3 * nt + 1] = B; idx[3 * nt + 2] = C; nt++;
        }
        o += s;
      }
      faceLast[fi] = nt - 1; // first > last when a face had only degenerate triangles
    });
    const hasN = faces.length > 0 && faces.every((f) => f.N);
    return {
      position: pos.slice(0, nv * 3), normal: hasN ? nor.slice(0, nv * 3) : null,
      index: idx.slice(0, nt * 3), faceFirst, faceLast,
    };
  }

  /** Apply a 4x4 column-major (SolidWorks / three.js layout) transform with translation in meters. */
  function transformMesh(m, T) {
    if (!T) return { ...m, position: m.position.slice(), normal: m.normal && m.normal.slice(), index: m.index.slice(), faceFirst: m.faceFirst.slice(), faceLast: m.faceLast.slice() };
    const [r00, r10, r20, , r01, r11, r21, , r02, r12, r22, , tx, ty, tz] = T;
    const p = m.position, P = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      P[i] = r00 * x + r01 * y + r02 * z + tx * 1000;
      P[i + 1] = r10 * x + r11 * y + r12 * z + ty * 1000;
      P[i + 2] = r20 * x + r21 * y + r22 * z + tz * 1000;
    }
    let Nn = null;
    if (m.normal) {
      const n = m.normal; Nn = new Float32Array(n.length);
      for (let i = 0; i < n.length; i += 3) {
        const x = n[i], y = n[i + 1], z = n[i + 2];
        Nn[i] = r00 * x + r01 * y + r02 * z; Nn[i + 1] = r10 * x + r11 * y + r12 * z; Nn[i + 2] = r20 * x + r21 * y + r22 * z;
      }
    }
    const det = r00 * (r11 * r22 - r12 * r21) - r01 * (r10 * r22 - r12 * r20) + r02 * (r10 * r21 - r11 * r20);
    const I = m.index.slice();
    if (det < 0) for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    return { position: P, normal: Nn, index: I, faceFirst: m.faceFirst.slice(), faceLast: m.faceLast.slice() };
  }
  function mul(A, B) { // column-major 4x4
    const C = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
      C[c * 4 + r] = s;
    }
    return C;
  }
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // ------------------------------------------------------------------ assembly XML
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));
  function attrs(s) {
    const o = {};
    for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = unesc(m[2]);
    return o;
  }
  function parseCompTree(xml) {
    const files = new Map(), models = new Map(), refd = new Set();
    let cur = null, rootRef = null;
    for (const m of xml.matchAll(/<(\/?)(sw\w+)([^>]*?)(\/?)>/g)) {
      const [, close, tag, body, self] = m;
      if (close) { if (tag === 'swModel') cur = null; continue; }
      const a = attrs(body);
      if (tag === 'swFile') files.set(a.id, a);
      else if (tag === 'swModel') { const md = { ...a, refs: [] }; models.set(a.id, md); cur = self ? null : md; }
      else if (tag === 'swReference' && cur) { cur.refs.push(a); refd.add(a.swModelRef); }
      else if (tag === 'swConfiguration' && a.swModelRef && (a.swMostRecentConfiguration === 'YES' || !rootRef)) rootRef = a.swModelRef;
    }
    let root = rootRef && models.get(rootRef);
    if (!root || !root.refs.length) root = [...models.values()].find((md) => md.refs.length && !refd.has(md.id)) || root;
    return { files, models, root };
  }

  // ------------------------------------------------------------------ FaceTessellations directory
  function cstr(u8, dv, i) {
    if (u8[i] !== 0xff || u8[i + 1] !== 0xfe || u8[i + 2] !== 0xff) return null;
    let n = u8[i + 3], j = i + 4;
    if (n === 0xff) { n = dv.getUint16(j, true); j += 2; if (n === 0xffff) { n = dv.getUint32(j, true); j += 4; } }
    return { s: td16.decode(u8.subarray(j, j + 2 * n)), end: j + 2 * n };
  }
  const hex = (u8, a, b) => Array.from(u8.subarray(a, b), (x) => x.toString(16).padStart(2, '0')).join('');
  function parseDirectory(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let i = 0;
    while (i < u8.length) {
      // resync on the next CString
      let k = i;
      while (k + 3 < u8.length && !(u8[k] === 0xff && u8[k + 1] === 0xfe && u8[k + 2] === 0xff)) k++;
      if (k + 3 >= u8.length) break;
      const nm = cstr(u8, dv, k);
      if (!nm) { i = k + 1; continue; }
      let j = nm.end;
      if (j + 28 > u8.length) break;
      // [u32 stamp][8 bytes][8 bytes: hash of the instance whose tessellation is shared][8 bytes: own hash]
      const shared = hex(u8, j + 12, j + 20), hash = hex(u8, j + 20, j + 28), hashBytes = u8.slice(j + 20, j + 28);
      j += 28;
      const st = cstr(u8, dv, j);
      if (!st) { i = j; continue; }
      out.push({ name: nm.s, shared, hash, hashBytes, stream: st.s });
      i = st.end;
    }
    return out;
  }
  const ZERO_HASH = '0000000000000000';
  /** instance key: "name-1/sub-2" from "name-1@parent/sub-2@name" */
  const dirKey = (name) => name.split('/').map((s) => { const a = s.lastIndexOf('@'); return a >= 0 ? s.slice(0, a) : s; }).join('/');

  function indexOf(hay, needle, from = 0) {
    const n0 = needle[0], L = needle.length;
    outer: for (let i = hay.indexOf(n0, from); i >= 0 && i + L <= hay.length; i = hay.indexOf(n0, i + 1)) {
      for (let k = 1; k < L; k++) if (hay[i + k] !== needle[k]) continue outer;
      return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ public API
  const PALETTE = [
    [0.70, 0.74, 0.80], [0.82, 0.66, 0.46], [0.53, 0.70, 0.62], [0.74, 0.60, 0.74], [0.85, 0.78, 0.50],
    [0.52, 0.64, 0.82], [0.80, 0.56, 0.56], [0.60, 0.76, 0.48], [0.62, 0.62, 0.66], [0.47, 0.72, 0.78],
  ];
  const stem = (p) => { const b = p.split(/[\\/]/).pop(); const d = b.lastIndexOf('.'); return d > 0 ? b.slice(0, d) : b; };
  const base = (p) => p.split(/[\\/]/).pop();

  async function readPartMesh(u8, label) {
    if (Container.isOle(u8)) throw new Error(`${label}: SolidWorks 2015 이전 형식은 지원하지 않습니다.`);
    const c = new Container(u8);
    const dl = await c.get('Contents/DisplayLists');
    if (!dl) throw new Error(`${label}: 표시 데이터(DisplayLists)가 없습니다. SolidWorks에서 다시 저장해 주세요.`);
    const faces = scanFaces(dl, 0, dl.length, dlFacePredicate(dl));
    if (!faces.length) throw new Error(`${label}: 표시 데이터에서 ${faces.invalid ? '손상되지 않은 ' : ''}면을 찾지 못했습니다.`);
    const m = facesToMesh(faces);
    m.invalidFaces = faces.invalid || 0;
    return m;
  }

  /**
   * @param {Uint8Array} u8 file bytes
   * @param {string} name file name
   * @param {(fileName:string)=>Promise<ArrayBuffer|null>} [resolve] sibling-file resolver (fallback only)
   * @param {{noCache?:boolean}} [opt] noCache: ignore embedded tessellation cache (testing)
   * @returns {Promise<{meshes, tree, missing:string[], usedSiblings:string[]}>} meshes in mm (local transforms baked)
   */
  async function read(u8, name, resolve, opt = {}) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (Container.isOle(u8)) throw new Error('SolidWorks 2015 이전 형식(OLE)은 지원하지 않습니다. 최신 SolidWorks에서 다시 저장하거나 STEP으로 내보내 주세요.');
    if (ext === 'sldprt') {
      const m = await readPartMesh(u8, name);
      const invalidFaces = m.invalidFaces; delete m.invalidFaces;
      return { meshes: [{ name: stem(name), color: null, hidden: false, ...m }], tree: { name: stem(name), meshes: [0], children: [] }, missing: [], usedSiblings: [], invalidFaces };
    }
    if (ext !== 'sldasm') throw new Error('SolidWorks 파일이 아닙니다.');
    const c = new Container(u8);
    const xmlB = await c.get('swXmlContents/COMPINSTANCETREE');
    if (!xmlB) throw new Error('조립품 구성 정보(COMPINSTANCETREE)를 찾지 못했습니다.');
    const { files, models, root } = parseCompTree(td8.decode(xmlB));
    if (!root) throw new Error('조립품 구성 정보를 해석하지 못했습니다.');

    // embedded tessellation cache
    const dirMap = new Map();
    const streams = new Map();
    if (!opt.noCache) {
      const dirB = await c.get('FaceTessellations/Directory');
      if (dirB) {
        const ents = parseDirectory(dirB);
        const starts = new Map(); // stream -> sorted offsets
        const byHash = new Map();
        for (const e of ents) {
          if (!e.stream || e.hash === ZERO_HASH) continue;
          if (!streams.has(e.stream)) streams.set(e.stream, await c.get('FaceTessellations/' + e.stream));
          const s = streams.get(e.stream);
          if (!s) continue;
          const off = indexOf(s, e.hashBytes);
          if (off < 0) continue;
          byHash.set(e.hash, { stream: e.stream, off });
          if (!starts.has(e.stream)) starts.set(e.stream, []);
          starts.get(e.stream).push(off);
        }
        for (const a of starts.values()) a.sort((x, y) => x - y);
        for (const e of ents) {
          const h = e.stream && byHash.has(e.hash) ? e.hash : e.shared;
          const loc = byHash.get(h);
          if (!loc) continue;
          const st = starts.get(loc.stream);
          const end = st.find((x) => x > loc.off) ?? streams.get(loc.stream).length;
          dirMap.set(dirKey(e.name), { key: loc.stream + '@' + loc.off, stream: loc.stream, lo: loc.off, hi: end });
        }
      }
    }

    const localCache = new Map(); // key -> local mesh
    const colorOf = new Map();
    const meshes = [], missing = [], usedSiblings = [];
    const getLocal = async (key, loader) => {
      if (!localCache.has(key)) localCache.set(key, loader());
      return localCache.get(key);
    };
    const ok = (m) => m && m.index.length > 0;
    /** -> array of {name?, position, normal, index, faceFirst, faceLast} in component-local mm, or null */
    const stepMeshes = (sname) => getLocal('s:' + sname.toLowerCase(), async () => {
      const buf = await resolve(sname);
      if (!buf) return null;
      usedSiblings.push(sname);
      return opt.readStep(buf, sname).catch(() => null);
    });
    /** every (unsuppressed) leaf below has an embedded tessellation */
    const allCached = (model, chain) => model.refs.every((r) => {
      if (r.swSuppressed === 'YES') return true;
      const child = models.get(r.swModelRef);
      if (!child) return true;
      const key = `${chain}/${r.swName}-${r.swReferenceNumber || 1}`;
      return child.refs.length ? allCached(child, key) : dirMap.has(key);
    });
    const leafMeshes = async (chain, model, importedAnc) => {
      const loc = dirMap.get(chain);
      if (loc) {
        const m = await getLocal('c:' + loc.key, async () => {
          const fs = scanFaces(streams.get(loc.stream), loc.lo, loc.hi);
          const mm = facesToMesh(fs);
          mm.invalidFaces = fs.invalid || 0;
          return mm;
        });
        if (ok(m)) return [m];
      }
      const f = files.get(model.swFileRef);
      if (!f) return null;
      const fname = base(f.swPath || '');
      // STEP imported via 3D Interconnect: SolidWorks embeds the generated SLDPRT (usually without display data)
      if (c.has('ImportedComp/' + fname)) {
        const m = await getLocal('i:' + fname, async () => {
          const b = await c.get('ImportedComp/' + fname);
          return b ? readPartMesh(b, fname).catch(() => null) : null;
        });
        if (ok(m)) return [m];
      }
      if (!resolve) return null;
      if ((f.swDocType || '').toUpperCase() === 'PART' && /\.sldprt$/i.test(fname)) {
        const m = await getLocal('f:' + fname.toLowerCase(), async () => {
          const buf = await resolve(fname);
          if (!buf) return null;
          usedSiblings.push(fname);
          return readPartMesh(new Uint8Array(buf), fname).catch(() => null);
        });
        if (ok(m)) return [m];
      }
      // ... and the original STEP file it was imported from (same coordinates). When the STEP was an
      // assembly, it is loaded once at the imported sub-assembly level instead (see walk).
      if (f.swImportedPath && opt.readStep && !importedAnc.has(f.swImportedPath.toLowerCase())) {
        const ms = await stepMeshes(base(f.swImportedPath));
        if (ms && ms.some(ok)) return ms.filter(ok);
      }
      return null;
    };

    const addMeshes = (lms, Tr, label, fid, h, node) => {
      if (!colorOf.has(fid)) colorOf.set(fid, PALETTE[colorOf.size % PALETTE.length]);
      const target = lms.length === 1 ? node : { name: label, meshes: [], children: [] };
      if (target !== node) node.children.push(target);
      lms.forEach((lm, bi) => {
        const nm = lms.length === 1 ? label : (lm.name || `Body ${bi + 1}`);
        const wm = transformMesh(lm, Tr);
        meshes.push({ name: nm, color: lm.color || colorOf.get(fid), hidden: h, ...wm });
        target.children.push({ name: nm, meshes: [meshes.length - 1], children: [] });
      });
    };
    const walk = async (model, T, chain, hidden, node, importedAnc = new Set()) => {
      const counts = new Map();
      for (const r of model.refs) {
        if (r.swSuppressed === 'YES') continue;
        const child = models.get(r.swModelRef);
        if (!child) continue;
        const num = r.swReferenceNumber || String((counts.get(r.swName) || 0) + 1);
        counts.set(r.swName, Number(num));
        const key = (chain ? chain + '/' : '') + `${r.swName}-${num}`;
        const vals = (r.swTransform || '').trim().split(/\s+/).map(Number);
        const Tr = mul(T, vals.length === 16 && vals.every(Number.isFinite) ? vals : IDENT);
        const h = hidden || r.swHidden === 'YES';
        const label = `${r.swName}<${num}>`;
        const cf = files.get(child.swFileRef);
        const imp = cf && cf.swImportedPath ? cf.swImportedPath.toLowerCase() : null;
        if (child.refs.length) {
          // STEP assembly imported via 3D Interconnect without embedded tessellation: load the STEP once here
          if (imp && resolve && opt.readStep && !allCached(child, key)) {
            const ms = await stepMeshes(base(cf.swImportedPath));
            if (ms && ms.some(ok)) { addMeshes(ms.filter(ok), Tr, label, child.swFileRef, h, node); continue; }
          }
          const sub = { name: label, meshes: [], children: [] };
          node.children.push(sub);
          const anc = imp ? new Set([...importedAnc, imp]) : importedAnc;
          await walk(child, Tr, key, h, sub, anc);
          continue;
        }
        const lms = await leafMeshes(key, child, importedAnc);
        if (!lms) { missing.push(label); continue; }
        addMeshes(lms, Tr, label, child.swFileRef || r.swName, h, node);
      }
    };
    const tree = { name: stem(name), meshes: [], children: [] };
    await walk(root, IDENT, '', false, tree);
    let invalidFaces = 0;
    for (const p of await Promise.all(localCache.values())) if (p && !Array.isArray(p)) invalidFaces += p.invalidFaces || 0;
    if (!meshes.length) throw new Error('조립품에서 표시할 부품 형상을 찾지 못했습니다' + (missing.length ? ` (누락 ${missing.length}개)` : '') + '.');
    return { meshes, tree, missing, usedSiblings, invalidFaces };
  }

  const API = { read, Container, scanFaces, facesToMesh, parseCompTree, parseDirectory, inflateRaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else G.SWFile = API;
})(typeof self !== 'undefined' ? self : globalThis);
