/* URDF robot description reader (plus STL / OBJ meshes).
 *
 * read() parses the URDF, asks for every referenced mesh file, and returns one mesh per link visual in the
 * link's own frame (mm), together with the kinematic tree (joints with origin, axis, limits, mimic) that the
 * viewer uses to place the links and move the joints.
 *
 * Triangle soups (STL, OBJ, primitives) are welded and split into faces (planar regions and smooth regions
 * bounded by sharp creases), so face picking, CAD edges and smooth shading work as for B-rep files.
 *
 * Units: URDF and its meshes are in meters (mesh scale applies); the output is in millimeters.
 * Works in a worker (self.URDFFile) and in Node (module.exports).
 */
(function (G) {
  'use strict';

  const MM = 1000;

  // ------------------------------------------------------------------ minimal XML
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
  /** XML text -> element tree { tag, attr, children } (comments, PIs, DOCTYPE and CDATA are skipped) */
  function parseXml(text) {
    const root = { tag: '#doc', attr: {}, children: [] };
    const stack = [root];
    let i = 0;
    const n = text.length;
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); i = e < 0 ? n : e + 3; continue; }
      if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
      // find the end of the tag, skipping '>' inside quoted attribute values
      let j = lt + 1, q = '';
      for (; j < n; j++) {
        const c = text[j];
        if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      }
      if (j >= n) throw new Error('URDF(XML) 태그가 닫히지 않았습니다.');
      const body = text.slice(lt + 1, j);
      i = j + 1;
      if (body[0] === '/') {
        const tag = body.slice(1).trim();
        // pop up to the matching tag (tolerates unclosed children)
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === tag) { stack.length = k; break; }
        continue;
      }
      const self = body.endsWith('/');
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) continue;
      const el = { tag: m[1], attr: {}, children: [] };
      const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      const rest = body.slice(m[1].length);
      while ((a = re.exec(rest))) el.attr[a[1]] = unescape(a[3] !== undefined ? a[3] : a[4]);
      stack[stack.length - 1].children.push(el);
      if (!self) stack.push(el);
    }
    return root;
  }
  const kids = (el, tag) => el.children.filter((c) => c.tag === tag);
  const kid = (el, tag) => el.children.find((c) => c.tag === tag) || null;
  const nums = (s, count, def) => {
    if (s === undefined || s === null) return def.slice();
    const v = String(s).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.length === 1 && count === 3 && def.length === 3 && def[0] === 1 && def[1] === 1 && def[2] === 1) return [v[0], v[0], v[0]]; // scale="2"
    if (v.length < count || v.slice(0, count).some((x) => !Number.isFinite(x))) return def.slice();
    return v.slice(0, count);
  };
  const num = (s, def) => { const v = Number(s); return s !== undefined && s !== '' && Number.isFinite(v) ? v : def; };

  // ------------------------------------------------------------------ transforms (column-major 4x4, like three.js)
  /** URDF origin: translation xyz and fixed-axis roll/pitch/yaw, R = Rz(yaw) Ry(pitch) Rx(roll) */
  function originMatrix(xyz, rpy, unit = 1) {
    const [r, p, y] = rpy;
    const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
    // rows of R
    const m00 = cy * cp, m01 = cy * sp * sr - sy * cr, m02 = cy * sp * cr + sy * sr;
    const m10 = sy * cp, m11 = sy * sp * sr + cy * cr, m12 = sy * sp * cr - cy * sr;
    const m20 = -sp, m21 = cp * sr, m22 = cp * cr;
    return [m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0, xyz[0] * unit, xyz[1] * unit, xyz[2] * unit, 1];
  }
  const parseOrigin = (el) => ({ xyz: nums(el && el.attr.xyz, 3, [0, 0, 0]), rpy: nums(el && el.attr.rpy, 3, [0, 0, 0]) });

  // ------------------------------------------------------------------ URDF model
  const JOINT_TYPES = new Set(['revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar']);
  function parseUrdf(text) {
    const doc = parseXml(text);
    const robot = doc.children.find((c) => c.tag === 'robot');
    if (!robot) {
      if (/xmlns:xacro|<xacro:/.test(text)) throw new Error('xacro 파일입니다. `xacro` 로 URDF를 생성한 뒤 여세요.');
      throw new Error('URDF 파일이 아닙니다 (<robot> 요소가 없습니다).');
    }
    const warnings = [];
    if (robot.children.some((c) => c.tag.startsWith('xacro:'))) warnings.push('xacro 매크로가 포함되어 있습니다. 전개되지 않은 부분은 무시됩니다.');
    const materials = new Map();
    const readMaterial = (el) => {
      if (!el) return null;
      const c = kid(el, 'color');
      const rgba = c ? nums(c.attr.rgba, 4, [NaN, 0, 0, 1]) : null;
      if (rgba && Number.isFinite(rgba[0])) { const m = { rgba }; if (el.attr.name) materials.set(el.attr.name, m); return m; }
      if (el.attr.name && materials.has(el.attr.name)) return materials.get(el.attr.name);
      return el.attr.name ? { ref: el.attr.name } : null;
    };
    for (const m of kids(robot, 'material')) readMaterial(m);
    const links = [];
    const linkNames = new Set();
    for (const l of kids(robot, 'link')) {
      const name = l.attr.name;
      if (!name) { warnings.push('이름 없는 link를 건너뛰었습니다.'); continue; }
      if (linkNames.has(name)) { warnings.push(`link "${name}"가 중복 정의되었습니다.`); continue; }
      linkNames.add(name);
      const visuals = [];
      for (const v of kids(l, 'visual')) {
        const g = kid(v, 'geometry');
        const shape = g && g.children[0];
        if (!shape) continue;
        const o = parseOrigin(kid(v, 'origin'));
        let geom = null;
        if (shape.tag === 'mesh') geom = { type: 'mesh', filename: shape.attr.filename || '', scale: nums(shape.attr.scale, 3, [1, 1, 1]) };
        else if (shape.tag === 'box') geom = { type: 'box', size: nums(shape.attr.size, 3, [0, 0, 0]) };
        else if (shape.tag === 'cylinder') geom = { type: 'cylinder', radius: num(shape.attr.radius, 0), length: num(shape.attr.length, 0) };
        else if (shape.tag === 'sphere') geom = { type: 'sphere', radius: num(shape.attr.radius, 0) };
        else if (shape.tag === 'capsule') geom = { type: 'capsule', radius: num(shape.attr.radius, 0), length: num(shape.attr.length, 0) };
        if (!geom) { warnings.push(`link "${name}": 지원하지 않는 형상 <${shape.tag}>`); continue; }
        visuals.push({ name: v.attr.name || '', origin: o, geom, material: readMaterial(kid(v, 'material')) });
      }
      links.push({ name, visuals });
    }
    // material references defined after their use
    for (const l of links) for (const v of l.visuals) if (v.material && v.material.ref) v.material = materials.get(v.material.ref) || null;

    const joints = [];
    const childOf = new Map();
    for (const j of kids(robot, 'joint')) {
      const name = j.attr.name || `joint${joints.length + 1}`;
      let type = j.attr.type || '';
      const parent = kid(j, 'parent') && kid(j, 'parent').attr.link;
      const child = kid(j, 'child') && kid(j, 'child').attr.link;
      if (!JOINT_TYPES.has(type)) { warnings.push(`joint "${name}": 알 수 없는 유형 "${type}" → 고정으로 처리`); type = 'fixed'; }
      if (!linkNames.has(parent) || !linkNames.has(child)) { warnings.push(`joint "${name}": 없는 link를 참조합니다 (${parent} → ${child}).`); continue; }
      if (childOf.has(child)) { warnings.push(`link "${child}"의 부모 joint가 둘 이상입니다 ("${name}" 무시).`); continue; }
      if (type === 'floating' || type === 'planar') { warnings.push(`joint "${name}": ${type} 관절은 움직일 수 없어 고정으로 표시합니다.`); }
      const o = parseOrigin(kid(j, 'origin'));
      let axis = nums(kid(j, 'axis') && kid(j, 'axis').attr.xyz, 3, [1, 0, 0]);
      const al = Math.hypot(axis[0], axis[1], axis[2]);
      if (!(al > 1e-12)) { if (type !== 'fixed') warnings.push(`joint "${name}": 축 벡터가 0입니다 → (1 0 0)`); axis = [1, 0, 0]; }
      else axis = axis.map((x) => x / al);
      const lim = kid(j, 'limit');
      let lower = num(lim && lim.attr.lower, 0), upper = num(lim && lim.attr.upper, 0);
      let hasLimit = !!lim && type !== 'continuous';
      // lower = upper is a valid, locked joint (kept as is); only a missing <limit> (required by URDF) gets a range
      if ((type === 'revolute' || type === 'prismatic') && !lim) {
        warnings.push(`joint "${name}": <limit>이 없어 범위를 임의로 정했습니다.`);
        hasLimit = false;
        if (type === 'revolute') { lower = -Math.PI; upper = Math.PI; } else { lower = -0.1; upper = 0.1; }
      }
      if (lower > upper) { warnings.push(`joint "${name}": lower > upper → 바꿔서 사용합니다.`); const t = lower; lower = upper; upper = t; }
      if (type === 'continuous') { lower = -Math.PI; upper = Math.PI; }
      const mim = kid(j, 'mimic');
      const mimic = mim && mim.attr.joint ? { joint: mim.attr.joint, multiplier: num(mim.attr.multiplier, 1), offset: num(mim.attr.offset, 0) } : null;
      const movable = type === 'revolute' || type === 'continuous' || type === 'prismatic';
      childOf.set(child, joints.length);
      joints.push({ name, decl: joints.length, type: movable ? type : 'fixed', declaredType: type, parent, child, origin: originMatrix(o.xyz, o.rpy, MM), axis, lower, upper, hasLimit, mimic,
        effort: num(lim && lim.attr.effort, null), velocity: num(lim && lim.attr.velocity, null) });
    }
    // mimic targets must exist and be movable; mimic cycles are dropped
    const byName = new Map(joints.map((j) => [j.name, j]));
    for (const j of joints) {
      if (!j.mimic) continue;
      const t = byName.get(j.mimic.joint);
      if (!t || t === j || t.type === 'fixed' || j.type === 'fixed') { warnings.push(`joint "${j.name}": mimic 대상 "${j.mimic.joint}"을 쓸 수 없어 무시합니다.`); j.mimic = null; }
    }
    for (const j of joints) {
      const seen = new Set([j]);
      let t = j;
      while (t && t.mimic) { t = byName.get(t.mimic.joint); if (seen.has(t)) { warnings.push(`joint "${j.name}": mimic 순환 → 무시`); j.mimic = null; break; } seen.add(t); }
    }
    // roots (links that are nobody's child) and a breadth-first order; links in a cycle are unreachable
    const childJoints = new Map(links.map((l) => [l.name, []]));
    joints.forEach((j, i) => childJoints.get(j.parent).push(i));
    const roots = links.filter((l) => !childOf.has(l.name)).map((l) => l.name);
    if (!roots.length && links.length) throw new Error('URDF의 joint가 순환 구조입니다 (루트 link가 없습니다).');
    if (roots.length > 1) warnings.push(`루트 link가 ${roots.length}개입니다 (${roots.slice(0, 3).join(', ')}${roots.length > 3 ? '…' : ''}). 모두 원점에 둡니다.`);
    const order = [];
    const reached = new Set(roots);
    const queue = roots.slice();
    while (queue.length) {
      const l = queue.shift();
      for (const ji of childJoints.get(l)) { order.push(ji); if (!reached.has(joints[ji].child)) { reached.add(joints[ji].child); queue.push(joints[ji].child); } }
    }
    if (reached.size < links.length) warnings.push(`순환 구조 때문에 link ${links.length - reached.size}개를 배치하지 못했습니다.`);
    return { name: robot.attr.name || '', links: links.filter((l) => reached.has(l.name)), joints: order.map((i) => joints[i]), roots, childJoints, warnings };
  }

  // ------------------------------------------------------------------ mesh files -> triangle soups (meters)
  // STL parsing is shared with standalone .stl files (stlfile.js): binary/ASCII detection (binary headers that start
  // with "solid", trailing bytes), and truncated, incomplete or NaN files are reported instead of shown half-read
  const stlReader = () => G.STLFile || (typeof require === 'function' ? require('./stlfile.js') : null);
  function readStl(bytes) {
    const STL = stlReader();
    if (!STL) throw new Error('STL 리더(stlfile.js)를 불러오지 못했습니다.');
    return STL.soup(bytes);
  }
  /** planar polygon (3D points, in order) -> triangles, ear clipping in its own plane (concave polygons are fine) */
  function triangulate(poly) {
    if (poly.length === 3) return [poly];
    let nx = 0, ny = 0, nz = 0; // Newell normal
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    // drop the dominant axis; flip one coordinate so the polygon is counter-clockwise in 2D
    const [u, v, s] = az >= ax && az >= ay ? [0, 1, nz] : ax >= ay ? [1, 2, nx] : [2, 0, ny];
    const P = poly.map((p) => [p[u], s < 0 ? -p[v] : p[v]]);
    const cross = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
    const inside = (a, b, c, p) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
    const idx = poly.map((_, i) => i), out = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < poly.length * poly.length) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
        if (cross(a, b, c) <= 0) continue; // reflex (or flat) corner
        if (idx.some((k) => k !== a && k !== b && k !== c && inside(a, b, c, k))) continue;
        out.push([poly[a], poly[b], poly[c]]);
        idx.splice(i, 1);
        cut = true;
        break;
      }
      if (!cut) break; // degenerate / self-intersecting: fan the rest
    }
    for (let k = 1; k + 1 < idx.length; k++) out.push([poly[idx[0]], poly[idx[k]], poly[idx[k + 1]]]);
    return out;
  }
  function readObj(bytes) {
    const text = new TextDecoder().decode(bytes);
    const V = [], out = [];
    for (const line of text.split(/\r?\n/)) {
      const tok = line.replace(/#.*/, '').trim().split(/\s+/); // comments may follow a record; spaces or tabs
      if (tok[0] === 'v') V.push([+tok[1], +tok[2], +tok[3]]);
      else if (tok[0] === 'f') {
        const poly = tok.slice(1).map((w) => { const i = parseInt(w, 10); return V[i < 0 ? V.length + i : i - 1]; });
        if (poly.length < 3 || poly.some((p) => !p)) continue;
        for (const [a, b, c] of triangulate(poly)) out.push(...a, ...b, ...c);
      }
    }
    if (!out.length) throw new Error('OBJ 파일에 면이 없습니다.');
    return Float32Array.from(out);
  }
  // primitives (meters, centered at the visual origin; cylinder and capsule along Z)
  function boxSoup([x, y, z]) {
    const h = [x / 2, y / 2, z / 2], out = [];
    const c = (i, j, k) => [i * h[0], j * h[1], k * h[2]];
    const quad = (a, b, cc, d) => out.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    quad(c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)); quad(c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1));
    quad(c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)); quad(c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1));
    quad(c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)); quad(c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1));
    return Float32Array.from(out);
  }
  /** surface of revolution about Z from a profile [[r, z], ...] (bottom to top) */
  function revolve(profile, seg = 48) {
    const out = [];
    const P = (r, z, k) => { const a = (2 * Math.PI * k) / seg; return [r * Math.cos(a), r * Math.sin(a), z]; };
    for (let i = 0; i + 1 < profile.length; i++) {
      const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
      for (let k = 0; k < seg; k++) {
        const a = P(r0, z0, k), b = P(r0, z0, k + 1), c = P(r1, z1, k + 1), d = P(r1, z1, k);
        if (r0 > 0) out.push(...a, ...b, ...c);
        if (r1 > 0) out.push(...a, ...c, ...d);
      }
    }
    return Float32Array.from(out);
  }
  const cylinderSoup = (r, l) => revolve([[0, -l / 2], [r, -l / 2], [r, l / 2], [0, l / 2]]);
  const arc = (r, zc, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [r * Math.cos(a), zc + r * Math.sin(a)]; });
  const sphereSoup = (r) => revolve(arc(r, 0, -Math.PI / 2, Math.PI / 2, 24));
  const capsuleSoup = (r, l) => revolve([...arc(r, -l / 2, -Math.PI / 2, 0, 12), ...arc(r, l / 2, 0, Math.PI / 2, 12)]);

  // ------------------------------------------------------------------ soup -> welded, face-segmented mesh
  const CREASE_COS = Math.cos((30 * Math.PI) / 180); // smooth regions stop at creases sharper than this
  const PLANE_COS = 0.99999; // same plane (0.26°)
  const PLANE_SHARE = 0.2; // a planar patch this large within a smooth region is a face of its own

  /** weld identical corners: soup (9 floats per triangle) -> { V (unique xyz), T (Int32 vertex ids, 3 per triangle) } */
  function weld(soup) {
    const nc = soup.length / 3;
    let cap = 1;
    while (cap < nc * 2) cap <<= 1;
    const table = new Int32Array(cap).fill(-1);
    const bits = new Uint32Array(3);
    const fbits = new Float32Array(bits.buffer);
    const V = new Float32Array(soup.length);
    const T = new Int32Array(nc);
    let nv = 0;
    for (let c = 0; c < nc; c++) {
      fbits[0] = soup[c * 3] + 0; fbits[1] = soup[c * 3 + 1] + 0; fbits[2] = soup[c * 3 + 2] + 0; // +0 turns -0 into 0
      let h = (Math.imul(bits[0], 73856093) ^ Math.imul(bits[1], 19349663) ^ Math.imul(bits[2], 83492791)) & (cap - 1);
      for (;;) {
        const v = table[h];
        if (v < 0) { table[h] = nv; V[nv * 3] = fbits[0]; V[nv * 3 + 1] = fbits[1]; V[nv * 3 + 2] = fbits[2]; T[c] = nv++; break; }
        if (V[v * 3] === fbits[0] && V[v * 3 + 1] === fbits[1] && V[v * 3 + 2] === fbits[2]) { T[c] = v; break; }
        h = (h + 1) & (cap - 1);
      }
    }
    return { V: V.slice(0, nv * 3), T };
  }

  /** @param soup triangle soup in mesh units; M column-major 4x4 applied to the vertices (in mm) */
  function buildMesh(soup, M) {
    const { V: raw, T: T0 } = weld(soup);
    const nv = raw.length / 3;
    // transform (doubles) -> mm
    const P = new Float64Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const x = raw[v * 3], y = raw[v * 3 + 1], z = raw[v * 3 + 2];
      P[v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
      P[v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      P[v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    }
    const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
    const flip = det < 0;
    // drop degenerate triangles; face normals + areas
    let nt = 0;
    const T = new Int32Array(T0.length);
    const N = new Float64Array(T0.length), A = new Float64Array(T0.length / 3);
    for (let t = 0; t < T0.length / 3; t++) {
      let a = T0[t * 3], b = T0[t * 3 + 1], c = T0[t * 3 + 2];
      if (flip) { const s = b; b = c; c = s; }
      if (a === b || b === c || a === c) continue;
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-14)) continue;
      T[nt * 3] = a; T[nt * 3 + 1] = b; T[nt * 3 + 2] = c;
      N[nt * 3] = nx / l; N[nt * 3 + 1] = ny / l; N[nt * 3 + 2] = nz / l;
      A[nt] = l / 2;
      nt++;
    }
    // edge neighbours: nbr[t*3+e] = slot of the triangle across edge e (manifold edges only), -1 otherwise
    const nbr = new Int32Array(nt * 3).fill(-1);
    const emap = new Map();
    for (let t = 0; t < nt; t++) {
      for (let e = 0; e < 3; e++) {
        let a = T[t * 3 + e], b = T[t * 3 + (e + 1) % 3];
        if (a > b) { const s = a; a = b; b = s; }
        const k = a * nv + b, s = t * 3 + e;
        const v = emap.get(k);
        if (v === undefined) emap.set(k, s);
        else if (v >= 0) { nbr[v] = s; nbr[s] = v; emap.set(k, -3 - v); }
        else if (v <= -3) { const s1 = -3 - v; nbr[nbr[s1]] = -1; nbr[s1] = -1; emap.set(k, -1); } // non-manifold: no neighbours
      }
    }
    const dotN = (t, u) => N[t * 3] * N[u * 3] + N[t * 3 + 1] * N[u * 3 + 1] + N[t * 3 + 2] * N[u * 3 + 2];
    // 1. smooth regions: grow across edges flatter than the crease angle
    const region = new Int32Array(nt).fill(-1);
    const stack = new Int32Array(nt);
    const regions = [];
    for (let s = 0; s < nt; s++) {
      if (region[s] >= 0) continue;
      const id = regions.length, list = [];
      let sp = 0, planar = true, area = 0;
      region[s] = id; stack[sp++] = s;
      while (sp) {
        const t = stack[--sp];
        list.push(t); area += A[t];
        if (planar && dotN(t, s) < PLANE_COS) planar = false;
        for (let e = 0; e < 3; e++) {
          const o = nbr[t * 3 + e];
          if (o < 0) continue;
          const u = (o / 3) | 0;
          if (region[u] < 0 && dotN(t, u) > CREASE_COS) { region[u] = id; stack[sp++] = u; }
        }
      }
      regions.push({ list, planar, area });
    }
    // 2. faces: planar regions as they are; a curved region gives up its large planar patches (a flat face
    //    meeting a fillet tangentially) and the rest splits into connected smooth pieces
    const face = new Int32Array(nt).fill(-1);
    let nf = 0;
    /** flood fill from seed over neighbours accepted by ok(t, u); returns the members */
    const fill = (seed, ok) => {
      const id = nf++, members = [seed];
      let sp = 0;
      face[seed] = id; stack[sp++] = seed;
      while (sp) {
        const t = stack[--sp];
        for (let e = 0; e < 3; e++) {
          const o = nbr[t * 3 + e];
          if (o < 0) continue;
          const u = (o / 3) | 0;
          if (face[u] < 0 && ok(t, u)) { face[u] = id; stack[sp++] = u; members.push(u); }
        }
      }
      return members;
    };
    for (let r = 0; r < regions.length; r++) {
      const R = regions[r];
      if (R.planar) { for (const t of R.list) face[t] = nf; nf++; continue; }
      // planar patches of this region (compared with the patch seed, so they cannot drift);
      // the small ones dissolve back into the smooth remainder
      const small = [];
      for (const s of R.list) {
        if (face[s] >= 0) continue;
        const members = fill(s, (t, u) => region[u] === r && dotN(s, u) > PLANE_COS);
        let pa = 0;
        for (const t of members) pa += A[t];
        if (pa < R.area * PLANE_SHARE) small.push(members);
      }
      for (const members of small) for (const t of members) face[t] = -1;
      for (const s of R.list) if (face[s] < 0) fill(s, (t, u) => region[u] === r && face[u] < 0 && dotN(t, u) > CREASE_COS);
    }
    // renumber faces compactly in order of first appearance
    const remap = new Int32Array(nf).fill(-1);
    let nfc = 0;
    for (let t = 0; t < nt; t++) if (remap[face[t]] < 0) remap[face[t]] = nfc++;
    for (let t = 0; t < nt; t++) face[t] = remap[face[t]];
    // triangles sorted by face (counting sort)
    const cnt = new Int32Array(nfc + 1);
    for (let t = 0; t < nt; t++) cnt[face[t] + 1]++;
    for (let f = 0; f < nfc; f++) cnt[f + 1] += cnt[f];
    const faceFirst = new Int32Array(nfc), faceLast = new Int32Array(nfc);
    for (let f = 0; f < nfc; f++) { faceFirst[f] = cnt[f]; faceLast[f] = cnt[f + 1] - 1; }
    const sorted = new Int32Array(nt);
    const at = cnt.slice(0, nfc);
    for (let t = 0; t < nt; t++) sorted[at[face[t]]++] = t;
    // vertices split per face; normals = area-weighted face normals within the face
    const stamp = new Int32Array(nv).fill(-1), local = new Int32Array(nv);
    const src = [];
    const index = new Uint32Array(nt * 3);
    const nAcc = [];
    for (let f = 0; f < nfc; f++) {
      for (let i = faceFirst[f]; i <= faceLast[f]; i++) {
        const t = sorted[i];
        for (let k = 0; k < 3; k++) {
          const v = T[t * 3 + k];
          if (stamp[v] !== f) { stamp[v] = f; local[v] = src.length; src.push(v); nAcc.push(0, 0, 0); }
          const w = local[v];
          index[i * 3 + k] = w;
          nAcc[w * 3] += N[t * 3] * A[t]; nAcc[w * 3 + 1] += N[t * 3 + 1] * A[t]; nAcc[w * 3 + 2] += N[t * 3 + 2] * A[t];
        }
      }
    }
    const nOut = src.length;
    const position = new Float32Array(nOut * 3), normal = new Float32Array(nOut * 3);
    for (let w = 0; w < nOut; w++) {
      const v = src[w];
      position[w * 3] = P[v * 3]; position[w * 3 + 1] = P[v * 3 + 1]; position[w * 3 + 2] = P[v * 3 + 2];
      const x = nAcc[w * 3], y = nAcc[w * 3 + 1], z = nAcc[w * 3 + 2], l = Math.hypot(x, y, z) || 1;
      normal[w * 3] = x / l; normal[w * 3 + 1] = y / l; normal[w * 3 + 2] = z / l;
    }
    return { position, normal, index, faceFirst, faceLast };
  }

  // ------------------------------------------------------------------ reading a robot
  const MESH_EXT = /\.(stl|obj)$/i;
  const baseName = (s) => s.replace(/\\/g, '/').split('/').pop();
  const lin2 = (c) => Math.min(1, Math.max(0, c));
  const mulM = (a, b) => {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  };

  /** one mesh file -> soup (meters), by extension */
  function soupFromFile(bytes, name) {
    if (/\.stl$/i.test(name)) return readStl(bytes);
    if (/\.obj$/i.test(name)) return readObj(bytes);
    throw new Error('지원하지 않는 메시 형식');
  }

  /**
   * @param bytes URDF file contents
   * @param fileName the URDF's name (robot name fallback)
   * @param getFile (reference) => Promise<ArrayBuffer|null>   mesh files by their URDF reference
   */
  async function read(bytes, fileName, getFile) {
    const u = parseUrdf(new TextDecoder().decode(bytes));
    const warnings = u.warnings.slice();
    const meshes = [];
    const missing = [], unsupported = [], used = [];
    const cache = new Map(); // same file used by several visuals: read it once
    const linkMeshes = new Map(u.links.map((l) => [l.name, []]));
    for (const l of u.links) {
      for (let vi = 0; vi < l.visuals.length; vi++) {
        const v = l.visuals[vi];
        const g = v.geom;
        let soup = null, label = '', scale = [1, 1, 1];
        if (g.type === 'mesh') {
          label = baseName(g.filename);
          scale = g.scale;
          if (!MESH_EXT.test(g.filename)) { unsupported.push(label || g.filename); continue; }
          let got = cache.get(g.filename);
          if (got === undefined) {
            const buf = await getFile(g.filename);
            got = buf ? { buf } : null;
            // every file that was read counts, even one that fails to parse: the result depends on it (never cached)
            if (got) { used.push(label); try { got.soup = soupFromFile(new Uint8Array(buf), g.filename); } catch (e) { got = null; warnings.push(`${label}: ${e.message}`); } }
            else missing.push(label);
            cache.set(g.filename, got);
          }
          if (!got) continue;
          soup = got.soup;
        } else if (g.type === 'box') { soup = boxSoup(g.size); label = 'box'; }
        else if (g.type === 'cylinder') { soup = cylinderSoup(g.radius, g.length); label = 'cylinder'; }
        else if (g.type === 'sphere') { soup = sphereSoup(g.radius); label = 'sphere'; }
        else if (g.type === 'capsule') { soup = capsuleSoup(g.radius, g.length); label = 'capsule'; }
        if (!soup || !soup.length) continue;
        // mesh (scaled, m) -> visual origin (m) -> mm
        const S = [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, 0, 0, 0, 1];
        const O = originMatrix(v.origin.xyz, v.origin.rpy, 1);
        const M = mulM(O, S).map((x, i) => (i === 15 ? 1 : x * MM));
        M[3] = 0; M[7] = 0; M[11] = 0;
        const m = buildMesh(soup, M);
        if (!m.index.length) continue;
        const rgba = v.material && v.material.rgba;
        m.name = l.visuals.length > 1 ? `${v.name || label} (${vi + 1})` : label;
        m.color = rgba ? [lin2(rgba[0]), lin2(rgba[1]), lin2(rgba[2])] : null;
        if (rgba && rgba[3] < 0.999) m.opacity = lin2(rgba[3]); // 0 = invisible, as in the URDF
        m.link = l.name;
        m.colors = null;
        linkMeshes.get(l.name).push(meshes.length);
        meshes.push(m);
      }
    }
    if (!meshes.length) {
      if (missing.length) throw new Error(`메시 파일을 찾지 못했습니다 (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' 외' : ''}). 메시가 URDF와 같은 폴더(또는 패키지 폴더)에 있으면 '열기' 버튼으로 여세요. 끌어다 놓을 때는 메시 파일도 함께 놓아야 합니다.`);
      throw new Error('표시할 형상이 없습니다 (visual이 없거나 지원하지 않는 형식).');
    }
    if (unsupported.length) warnings.push(`지원하지 않는 메시 형식(STL·OBJ만 지원) ${unsupported.length}개를 건너뛰었습니다: ${[...new Set(unsupported)].slice(0, 3).join(', ')}`);
    // model tree = kinematic tree; links without geometry below them are left out
    const jointsByParent = new Map();
    for (const j of u.joints) { if (!jointsByParent.has(j.parent)) jointsByParent.set(j.parent, []); jointsByParent.get(j.parent).push(j); }
    const node = (ln) => {
      const children = (jointsByParent.get(ln) || []).map((j) => node(j.child)).filter(Boolean);
      const ms = linkMeshes.get(ln) || [];
      if (!children.length && !ms.length) return null;
      return { name: ln, meshes: ms, children };
    };
    const tree = { name: u.name || fileName.replace(/\.[^.]+$/, ''), meshes: [], children: u.roots.map(node).filter(Boolean) };
    const robot = {
      name: u.name,
      links: u.links.map((l) => l.name),
      roots: u.roots,
      joints: u.joints.map((j) => ({ name: j.name, decl: j.decl, type: j.type, declaredType: j.declaredType, parent: j.parent, child: j.child, origin: j.origin, axis: j.axis,
        lower: j.lower, upper: j.upper, hasLimit: j.hasLimit, mimic: j.mimic, effort: j.effort, velocity: j.velocity })),
    };
    return { meshes, tree, robot, missing, usedSiblings: used, warnings };
  }

  /** a single STL / OBJ file as a part (mesh units are taken as mm) */
  function readMeshFile(bytes, fileName) {
    const soup = soupFromFile(bytes, fileName);
    const m = buildMesh(soup, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    if (!m.index.length) throw new Error('메시에 삼각형이 없습니다.');
    m.name = fileName.replace(/\.[^.]+$/, '');
    m.color = null;
    m.colors = null;
    return { meshes: [m], tree: { name: m.name, meshes: [0], children: [] } };
  }

  const API = { parseXml, parseUrdf, originMatrix, readStl, readObj, buildMesh, read, readMeshFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else G.URDFFile = API;
})(typeof self !== 'undefined' ? self : globalThis);
