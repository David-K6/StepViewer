/* Parasolid X_T (text transmit) reader.
 *
 * Decodes the node stream (embedded-schema format, base schema 13006, as written by current Onshape,
 * SolidWorks, NX ... exports) into B-rep topology + geometry and converts it to a STEP AP214 text, which
 * OpenCascade (occt-import-js) then heals and tessellates like any other STEP file.
 *
 * Node-stream decoding rules and the base field layouts of schema 13006 follow parasolid-kit
 * (https://github.com/monozukuri-ai/parasolid-kit, MIT License, Copyright (c) monozukuri-ai), which
 * derives them from the public Parasolid XT Format Reference. No Siemens schema catalog is used.
 *
 * Units: X_T stores meters; the STEP is written in millimeters.
 * Works in a worker (self.XTFile) and in Node (module.exports).
 */
(function (G) {
  'use strict';

  // ------------------------------------------------------------------ base schema 13006
  // field: [name, type code, pointer class, element count]; element count 0 = scalar, 1 = variable, n = fixed array
  const F = (name, t, cls = 0, n = 0) => ({ name, t: cls ? 'p' : t, cls, n, tx: true });
  const curveHead = () => [F('local_id', 'd'), F('annotations', 'p', 1019), F('owner_ref', 'p', 1010), F('next', 'p', 1008), F('previous', 'p', 1008), F('indirect_owner', 'p', 141), F('sense', 'c')];
  const surfHead = () => [F('local_id', 'd'), F('annotations', 'p', 1019), F('owner_ref', 'p', 1007), F('next', 'p', 1006), F('previous', 'p', 1006), F('indirect_owner', 'p', 141), F('sense', 'c')];
  const BASE = {
    10: [F('max_local_id', 'd'), F('annotations', 'p', 1019), F('attribute_lists', 'p', 70), F('list_ref', 'p', 70), F('construction_surfaces', 'p', 1006),
      F('construction_curves', 'p', 1008), F('construction_points', 'p', 29), F('key_ref', 'p', 102), F('size_precision', 'f'), F('linear_precision', 'f'),
      F('instances', 'p', 11), F('next_assembly', 'p', 10), F('previous_assembly', 'p', 10), F('storage_state', 'u'), F('legacy_owner', 'p', 101),
      F('assembly_kind', 'u'), F('sub_instances', 'p', 11)],
    11: [F('local_id', 'd'), F('annotations', 'p', 1019), F('instance_kind', 'u'), F('part_ref', 'p', 1005), F('transform_ref', 'p', 100), F('assembly_ref', 'p', 10),
      F('next_in_assembly', 'p', 11), F('previous_in_assembly', 'p', 11), F('next_of_part', 'p', 11), F('previous_of_part', 'p', 11)],
    12: [F('max_local_id', 'd'), F('annotations', 'p', 1019), F('attribute_lists', 'p', 70), F('construction_surfaces', 'p', 1006), F('construction_curves', 'p', 1008),
      F('construction_points', 'p', 29), F('key_ref', 'p', 102), F('size_precision', 'f'), F('linear_precision', 'f'), F('instances', 'p', 11), F('next_body', 'p', 12),
      F('previous_body', 'p', 12), F('storage_state', 'u'), F('legacy_owner', 'p', 101), F('body_kind', 'u'), F('geometry_state', 'u'), F('legacy_shell', 'p', 13),
      F('boundary_surfaces', 'p', 1006), F('boundary_curves', 'p', 1008), F('boundary_points', 'p', 29), F('region_head', 'p', 19), F('edge_head', 'p', 16), F('vertex_head', 'p', 18)],
    13: [F('local_id', 'd'), F('annotations', 'p', 1019), F('legacy_body', 'p', 12), F('next_shell', 'p', 13), F('back_faces', 'p', 14), F('wire_edges', 'p', 16),
      F('isolated_vertex', 'p', 18), F('region_ref', 'p', 19), F('front_faces', 'p', 14)],
    14: [F('local_id', 'd'), F('annotations', 'p', 1019), F('precision', 'f'), F('next_back', 'p', 14), F('previous_back', 'p', 14), F('loop_head', 'p', 15), F('back_shell', 'p', 13),
      F('surface_ref', 'p', 1006), F('sense', 'c'), F('next_surface_face', 'p', 14), F('previous_surface_face', 'p', 14), F('next_front', 'p', 14), F('previous_front', 'p', 14), F('front_shell', 'p', 13)],
    15: [F('local_id', 'd'), F('annotations', 'p', 1019), F('fin_ref', 'p', 17), F('face_ref', 'p', 14), F('next_loop', 'p', 15)],
    16: [F('local_id', 'd'), F('annotations', 'p', 1019), F('precision', 'f'), F('fin_ref', 'p', 17), F('previous_edge', 'p', 16), F('next_edge', 'p', 16), F('curve_ref', 'p', 1008),
      F('next_curve_edge', 'p', 16), F('previous_curve_edge', 'p', 16), F('owner_ref', 'p', 1029)],
    17: [F('annotations', 'p', 1019), F('loop_ref', 'p', 15), F('forward_fin', 'p', 17), F('backward_fin', 'p', 17), F('end_vertex', 'p', 18), F('radial_fin', 'p', 17), F('edge_ref', 'p', 16),
      F('curve_ref', 'p', 1008), F('next_vertex_fin', 'p', 17), F('sense', 'c')],
    18: [F('local_id', 'd'), F('annotations', 'p', 1019), F('fin_head', 'p', 17), F('previous_vertex', 'p', 18), F('next_vertex', 'p', 18), F('point_ref', 'p', 29), F('precision', 'f'), F('owner_ref', 'p', 1029)],
    19: [F('local_id', 'd'), F('annotations', 'p', 1019), F('body_ref', 'p', 12), F('next_region', 'p', 19), F('previous_region', 'p', 19), F('shell_head', 'p', 13), F('region_kind', 'c')],
    29: [F('local_id', 'd'), F('annotations', 'p', 1019), F('owner_ref', 'p', 1011), F('next_point', 'p', 29), F('previous_point', 'p', 29), F('position', 'v')],
    30: [...curveHead(), F('origin', 'v'), F('direction', 'v')],
    31: [...curveHead(), F('center', 'v'), F('normal', 'v'), F('x_axis', 'v'), F('radius', 'f')],
    32: [...curveHead(), F('center', 'v'), F('normal', 'v'), F('x_axis', 'v'), F('major_radius', 'f'), F('minor_radius', 'f')],
    38: [...curveHead(), F('surfaces', 'p', 1006, 2), F('chart', 'p', 40), F('start_limit', 'p', 41), F('end_limit', 'p', 41)],
    40: [F('base_parameter', 'f'), F('base_scale', 'f'), F('chart_count', 'd'), F('chordal_error', 'f'), F('angular_error', 'f'), F('parameter_errors', 'f', 0, 2), F('hvecs', 'h', 0, 1)],
    41: [F('kind', 'c'), F('hvecs', 'h', 0, 1)],
    45: [F('values', 'f', 0, 1)],
    50: [...surfHead(), F('origin', 'v'), F('normal', 'v'), F('x_axis', 'v')],
    51: [...surfHead(), F('origin', 'v'), F('axis', 'v'), F('radius', 'f'), F('x_axis', 'v')],
    52: [...surfHead(), F('origin', 'v'), F('axis', 'v'), F('radius', 'f'), F('sin_half_angle', 'f'), F('cos_half_angle', 'f'), F('x_axis', 'v')],
    53: [...surfHead(), F('center', 'v'), F('radius', 'f'), F('axis', 'v'), F('x_axis', 'v')],
    54: [...surfHead(), F('center', 'v'), F('axis', 'v'), F('major_radius', 'f'), F('minor_radius', 'f'), F('x_axis', 'v')],
    56: [...surfHead(), F('blend_kind', 'c'), F('supports', 'p', 1006, 2), F('spine', 'p', 1008), F('offsets', 'f', 0, 2), F('weights', 'f', 0, 2),
      F('boundary_surfaces', 'p', 1006, 2), F('start_limit', 'p', 41), F('end_limit', 'p', 41)],
    59: [...surfHead(), F('boundary_index', 'n'), F('blend_surface', 'p', 1006)],
    60: [...surfHead(), F('check_state', 'c'), F('true_offset', 'l'), F('basis', 'p', 1006), F('offset', 'f'), F('scale', 'f')],
    67: [...surfHead(), F('section', 'p', 1008), F('sweep', 'v'), F('scale', 'f')],
    68: [...surfHead(), F('profile', 'p', 1008), F('axis_origin', 'v'), F('axis_direction', 'v'), F('start_point', 'v'), F('end_point', 'v'),
      F('start_parameter', 'f'), F('end_parameter', 'f'), F('x_axis', 'v'), F('scale', 'f')],
    70: [F('local_id', 'd'), F('owner_ref', 'p', 1013), F('next_list', 'p', 70), F('previous_list', 'p', 70), F('entry_kind', 'd'), F('entry_count', 'd'), F('block_capacity', 'd'),
      F('entry_size', 'd'), F('block_head', 'p', 1012), F('cursor_block', 'p', 1012), F('cursor_index', 'd'), F('transmission_flag', 'l')],
    74: [F('used_count', 'd'), F('next_block', 'p', 74), F('entries', 'p', 1, 1)],
    79: [F('identifier_bytes', 'c', 0, 1)],
    80: [F('next_definition', 'p', 80), F('identifier_ref', 'p', 79), F('kind_id', 'd'), F('event_actions', 'u', 0, 8), F('field_labels', 'p', 99), F('allowed_owners', 'l', 0, 14), F('value_kinds', 'u', 0, 1)],
    81: [F('local_id', 'd'), F('definition_ref', 'p', 80), F('owner_ref', 'p', 1015), F('next_annotation', 'p', 1019), F('previous_annotation', 'p', 1019), F('next_same_kind', 'p', 81),
      F('previous_same_kind', 'p', 81), F('value_arrays', 'p', 1018, 1)],
    82: [F('values', 'd', 0, 1)],
    83: [F('values', 'f', 0, 1)],
    84: [F('values', 'c', 0, 1)],
    85: [F('values', 'v', 0, 1)], 86: [F('values', 'v', 0, 1)], 87: [F('values', 'v', 0, 1)], 88: [F('values', 't', 0, 1)], 89: [F('values', 'v', 0, 1)],
    98: [F('values', 'w', 0, 1)],
    100: [F('local_id', 'd'), F('owner_ref', 'p', 1023), F('next_transform', 'p', 100), F('previous_transform', 'p', 100), F('rotation', 'f', 0, 9), F('translation', 'v'),
      F('scale', 'f'), F('flag', 'd'), F('perspective', 'v')],
    124: [...surfHead(), F('nurbs', 'p', 126), F('data', 'p', 125)],
    125: [F('original_u_range', 'i'), F('original_v_range', 'i'), F('extended_u_range', 'i'), F('extended_v_range', 'i'), F('self_intersection_state', 'u'),
      ...['original_u_start', 'original_u_end', 'original_v_start', 'original_v_end', 'extended_u_start', 'extended_u_end', 'extended_v_start', 'extended_v_end',
        'analytic_kind', 'swept_kind', 'spun_kind', 'blend_kind'].map((n) => F(n, 'c')),
      F('analytic_form', 'p', 1030), F('swept_form', 'p', 1031), F('spun_form', 'p', 1032), F('blend_form', 'p', 1033)],
    126: [F('u_periodic', 'l'), F('v_periodic', 'l'), F('u_degree', 'n'), F('v_degree', 'n'), F('u_count', 'd'), F('v_count', 'd'), F('u_knot_kind', 'u'), F('v_knot_kind', 'u'),
      F('u_knot_count', 'd'), F('v_knot_count', 'd'), F('rational', 'l'), F('u_closed', 'l'), F('v_closed', 'l'), F('surface_form', 'u'), F('dim', 'n'),
      F('vertices', 'p', 45), F('u_mults', 'p', 127), F('v_mults', 'p', 127), F('u_knots', 'p', 128), F('v_knots', 'p', 128)],
    127: [F('values', 'n', 0, 1)],
    128: [F('values', 'f', 0, 1)],
    133: [...curveHead(), F('basis', 'p', 1008), F('start_point', 'v'), F('end_point', 'v'), F('start_parameter', 'f'), F('end_parameter', 'f')],
    134: [...curveHead(), F('nurbs', 'p', 136), F('data', 'p', 135)],
    135: [F('self_intersection_state', 'u'), F('analytic_form', 'p', 1036)],
    136: [F('degree', 'n'), F('count', 'd'), F('dim', 'n'), F('knot_count', 'd'), F('knot_kind', 'u'), F('periodic', 'l'), F('closed', 'l'), F('rational', 'l'), F('curve_form', 'u'),
      F('vertices', 'p', 45), F('mults', 'p', 127), F('knots', 'p', 128)],
    137: [...curveHead(), F('surface', 'p', 1006), F('pcurve', 'p', 134), F('original', 'p', 1008), F('original_tolerance', 'f')],
    141: [F('referencing', 'p', 1003), F('next_owner', 'p', 141), F('previous_owner', 'p', 141), F('shared', 'p', 1003)],
  };

  // ------------------------------------------------------------------ text node stream
  class Reader {
    constructor(text) { this.s = text; this.i = 0; this.spaces = 0; }
    peek() { return this.s.charCodeAt(this.i); }
    raw() { if (this.i >= this.s.length) throw new Error('X_T: unexpected end of data'); return this.s[this.i++]; }
    token() {
      const s = this.s;
      let j = this.i;
      while (j < s.length && s.charCodeAt(j) !== 32) j++;
      if (j === this.i) throw new Error(`X_T: empty token at ${this.i}`);
      const t = s.slice(this.i, j);
      this.i = j < s.length ? j + 1 : j;
      return t;
    }
    int() { const t = this.token(); const v = Number(t); if (!Number.isInteger(v)) throw new Error(`X_T: bad integer "${t}" at ${this.i}`); return v; }
    nint() { if (this.s[this.i] === '?') { this.i += 1; return null; } return this.int(); }
    num() {
      if (this.s[this.i] === '?') { this.i += 1; return null; }
      const t = this.token(); const v = Number(t);
      if (Number.isNaN(v)) throw new Error(`X_T: bad number "${t}" at ${this.i}`);
      return v;
    }
    char() {
      if (this.spaces) { this.spaces--; return ' '; }
      const c = this.raw();
      if (c !== '\\') return c;
      const e = this.raw();
      if (e === '9') { this.spaces = 8; return ' '; }
      return e === '0' ? '\0' : e === 'n' ? '\r' : e === 'r' ? '\n' : e;
    }
    str(len) { let o = ''; for (let k = 0; k < len; k++) o += this.char(); return o; }
  }

  /** logical text: physical lines joined, trailing spaces of each line dropped */
  function logicalText(u8, start) {
    const parts = [];
    let ls = start;
    const n = u8.length;
    const dec = new TextDecoder('latin1');
    while (ls < n) {
      let le = ls;
      while (le < n && u8[le] !== 10 && u8[le] !== 13) le++;
      let ce = le;
      while (ce > ls && u8[ce - 1] === 32) ce--;
      if (ce > ls) parts.push(dec.decode(u8.subarray(ls, ce)));
      ls = le + 1;
      if (u8[le] === 13 && u8[ls] === 10) ls++;
    }
    return parts.join('');
  }

  function payloadStart(u8) {
    // the optional human header ends with "**END_OF_HEADER" + stars + newline
    const head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536)));
    const k = head.indexOf('**END_OF_HEADER');
    if (k < 0) {
      if (head.startsWith('**ABCDEFGHIJKLMNOPQRSTUVWXYZ')) throw new Error('X_T 파일이 잘렸거나 손상되었습니다 (헤더가 끝나지 않음).');
      return 0;
    }
    let i = head.indexOf('\n', k);
    return i < 0 ? head.length : i + 1;
  }

  function readValue(r, t) {
    switch (t) {
      case 'c': return r.char();
      case 'l': { const c = r.raw(); if (c !== 'T' && c !== 'F') throw new Error(`X_T: bad logical "${c}"`); return c === 'T'; }
      case 'u': case 'n': case 'w': case 'd': case 't': return r.nint();
      case 'p': return r.int();
      case 'f': return r.num();
      case 'i': case 'v': case 'h': case 'b': {
        const k = t === 'i' ? 2 : t === 'b' ? 6 : 3;
        if (r.s[r.i] === '?') { r.i += 1; return null; }
        const o = new Array(k);
        for (let j = 0; j < k; j++) o[j] = r.num();
        return o;
      }
      default: throw new Error(`X_T: field type ${t} has no text form`);
    }
  }

  function readFieldDef(r) {
    const name = r.str(r.int());
    const cls = r.int();
    const n = r.int();
    let t = 'p';
    if (cls === 0) t = r.str(r.int());
    const tx = n === 1 ? r.raw() === 'T' : true;
    return { name, t, cls, n, tx };
  }

  /** decode the node stream -> { nodes: Map(index -> {type, f: {name: value}}), schema, header } */
  function decode(u8) {
    const text = logicalText(u8, payloadStart(u8));
    const r = new Reader(text);
    if (r.raw() !== 'T') throw new Error('X_T 텍스트 형식이 아닙니다 (바이너리 X_B는 지원하지 않습니다).');
    const modeller = r.str(r.int());
    const key = r.str(r.int());
    const m = /^SCH_(\d+)_(\d+)(?:_(\d+))?$/.exec(key);
    if (!m) throw new Error(`X_T: unknown schema key ${key}`);
    const embedded = !!m[3];
    if (embedded) r.int(); // highest node type
    const userFields = r.int();
    const defs = new Map();
    const nodes = new Map();
    for (;;) {
      const type = r.int();
      if (type === 1) break; // terminator (index 0)
      let def = defs.get(type);
      if (!def) {
        if (!embedded) {
          const b = BASE[type];
          if (!b) throw new Error(`X_T: node type ${type} is not supported (schema ${key})`);
          def = b;
        } else {
          const marker = r.int();
          const base = m[3] === '13006' ? BASE[type] : null;
          if (marker === 255) {
            if (!base) throw new Error(`X_T: node type ${type} uses base schema ${m[3]}, which is not known`);
            def = base;
          } else if (!base) {
            r.str(r.int()); r.str(r.int()); // type name, description
            def = [];
            for (let k = 0; k < marker; k++) def.push(readFieldDef(r));
          } else {
            def = [];
            let bi = 0;
            for (;;) {
              const op = r.raw();
              if (op === 'C') def.push(base[bi++]);
              else if (op === 'D') bi++;
              else if (op === 'I' || op === 'A') def.push(readFieldDef(r));
              else if (op === 'Z') break;
              else throw new Error(`X_T: bad schema opcode "${op}" for type ${type}`);
            }
            if (def.length !== marker) throw new Error(`X_T: schema of type ${type} has ${def.length} fields, declared ${marker}`);
          }
        }
        defs.set(type, def);
      }
      const variable = def.length && def[def.length - 1].n === 1 ? r.int() : 0;
      if (variable < 0) throw new Error(`X_T: bad length ${variable} of node type ${type}`);
      const index = r.int();
      const f = {};
      for (const fd of def) {
        if (!fd.tx) continue;
        const cnt = fd.n === 0 ? 1 : fd.n === 1 ? variable : fd.n;
        // an array can never hold more values than the rest of the input encodes: a value takes at least one
        // character, except characters, where "\9" (two characters) stands for nine spaces
        if (cnt > 1 && cnt > (text.length - r.i) * (fd.t === 'c' ? 4.5 : 1) + 9) throw new Error(`X_T: bad length ${cnt} of node type ${type}`);
        if (fd.n === 0) f[fd.name] = readValue(r, fd.t);
        else {
          const a = new Array(cnt);
          for (let k = 0; k < cnt; k++) a[k] = readValue(r, fd.t);
          f[fd.name] = fd.t === 'c' ? a.join('') : a;
        }
      }
      for (let k = 0; k < userFields; k++) r.nint();
      nodes.set(index, { type, index, f });
    }
    return { nodes, defs, key, modeller };
  }

  // ------------------------------------------------------------------ geometry evaluation (meters, natural parameters)
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dist = (a, b) => len(sub(a, b));

  /** NURBS from an XT nurbs node (curve 136 or surface 126) */
  /** distinct knots + multiplicities -> full knot vector; `expected` = control count + degree + 1 */
  function flatKnots(N, knotsRef, multsRef, count, expected) {
    const kn = N.get(knotsRef), mn = N.get(multsRef);
    if (!kn || !mn || !Array.isArray(kn.f.values) || !Array.isArray(mn.f.values)) throw new Error('X_T: missing knot data');
    // the arrays can be longer than the knot count (spare capacity): only the first `count` entries are real
    if (!Number.isInteger(count) || count < 2 || count > kn.f.values.length || count > mn.f.values.length) throw new Error('X_T: bad knot count');
    const k = kn.f.values.slice(0, count), m = mn.f.values.slice(0, count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      if (!Number.isInteger(m[i]) || m[i] < 1 || !Number.isFinite(k[i]) || (i && k[i] < k[i - 1])) throw new Error('X_T: bad knot vector');
      sum += m[i];
    }
    if (sum !== expected) throw new Error('X_T: knot multiplicities do not match the control points');
    const U = [];
    for (let i = 0; i < count; i++) for (let j = 0; j < m[i]; j++) U.push(k[i]);
    return { U, knots: k, mults: m };
  }
  function findSpan(n, p, t, U) { // n = control count - 1
    if (t >= U[n + 1]) return n;
    if (t <= U[p]) return p;
    let lo = p, hi = n + 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < U[mid]) hi = mid; else lo = mid; }
    return lo;
  }
  function basisFuns(i, t, p, U) {
    const Nf = [1], left = [], right = [];
    for (let j = 1; j <= p; j++) {
      left[j] = t - U[i + 1 - j]; right[j] = U[i + j] - t;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const den = right[r + 1] + left[j - r];
        const tmp = den ? Nf[r] / den : 0;
        Nf[r] = saved + right[r + 1] * tmp;
        saved = left[j - r] * tmp;
      }
      Nf[j] = saved;
    }
    return Nf;
  }
  function curveNurbs(N, nb) {
    const f = nb.f;
    const dim = f.dim, count = f.count;
    if (!Number.isInteger(f.degree) || f.degree < 1 || !Number.isInteger(count) || count <= f.degree || !(dim >= 2 && dim <= 4)) throw new Error('X_T: bad B-curve header');
    const raw = N.get(f.vertices) && N.get(f.vertices).f.values;
    if (!Array.isArray(raw) || raw.length < count * dim) throw new Error('X_T: B-curve control points missing');
    const { U, knots, mults } = flatKnots(N, f.knots, f.mults, f.knot_count, count + f.degree + 1);
    const P = [];
    for (let i = 0; i < count; i++) P.push(raw.slice(i * dim, i * dim + dim));
    if (U.length !== count + f.degree + 1 || P.some((q) => q.length !== dim || q.some((x) => !Number.isFinite(x)))) throw new Error('X_T: inconsistent B-curve');
    return { p: f.degree, U, knots, mults, P, dim, rational: !!f.rational, t0: U[f.degree], t1: U[count] };
  }
  /** point of a NURBS curve (homogeneous control points when rational); returns dim-1 or dim coords */
  function evalCurveNurbs(c, t) {
    const n = c.P.length - 1, span = findSpan(n, c.p, t, c.U), B = basisFuns(span, t, c.p, c.U);
    const d = c.dim, acc = new Array(d).fill(0);
    for (let j = 0; j <= c.p; j++) { const q = c.P[span - c.p + j]; for (let k = 0; k < d; k++) acc[k] += B[j] * q[k]; }
    if (!c.rational) return acc;
    const w = acc[d - 1];
    return acc.slice(0, d - 1).map((x) => x / w);
  }
  function surfNurbs(N, nb) {
    const f = nb.f;
    const dim = f.dim;
    if (![f.u_degree, f.v_degree].every((x) => Number.isInteger(x) && x >= 1) || !(f.u_count > f.u_degree) || !(f.v_count > f.v_degree) || !(dim === 3 || dim === 4)) throw new Error('X_T: bad B-surface header');
    const raw = N.get(f.vertices) && N.get(f.vertices).f.values;
    if (!Array.isArray(raw) || raw.length < f.u_count * f.v_count * dim) throw new Error('X_T: B-surface control points missing');
    const u = flatKnots(N, f.u_knots, f.u_mults, f.u_knot_count, f.u_count + f.u_degree + 1);
    const v = flatKnots(N, f.v_knots, f.v_mults, f.v_knot_count, f.v_count + f.v_degree + 1);
    const P = [];
    for (let i = 0; i < f.u_count * f.v_count; i++) P.push(raw.slice(i * dim, i * dim + dim));
    if (u.U.length !== f.u_count + f.u_degree + 1 || v.U.length !== f.v_count + f.v_degree + 1 || P.some((q) => q.length !== dim)) throw new Error('X_T: inconsistent B-surface');
    return { pu: f.u_degree, pv: f.v_degree, nu: f.u_count, nv: f.v_count, U: u.U, V: v.U, uk: u, vk: v, P, dim, rational: !!f.rational };
  }
  function evalSurfNurbs(s, u, v) {
    const su = findSpan(s.nu - 1, s.pu, u, s.U), sv = findSpan(s.nv - 1, s.pv, v, s.V);
    const Bu = basisFuns(su, u, s.pu, s.U), Bv = basisFuns(sv, v, s.pv, s.V);
    const acc = [0, 0, 0, 0];
    for (let a = 0; a <= s.pu; a++) {
      for (let b = 0; b <= s.pv; b++) {
        const q = s.P[(su - s.pu + a) * s.nv + (sv - s.pv + b)], w = Bu[a] * Bv[b];
        acc[0] += w * q[0]; acc[1] += w * q[1]; acc[2] += w * q[2]; acc[3] += w * (s.rational ? q[3] : 1);
      }
    }
    return s.rational ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]] : [acc[0], acc[1], acc[2]];
  }

  // ------------------------------------------------------------------ STEP writer
  function R(x) {
    if (!Number.isFinite(x)) throw new Error('X_T: non-finite number');
    if (Object.is(x, -0) || x === 0) return '0.';
    let s = String(x);
    if (s.includes('e')) { const [m, e] = s.split('e'); s = (m.includes('.') ? m : m + '.') + 'E' + e; }
    else if (!s.includes('.')) s += '.';
    return s;
  }
  const S = (s) => `'${String(s).replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_')}'`;

  /**
   * X_T bytes -> { step, bodies: [{ key, name, color }], stats }
   * Every body becomes its own STEP product (named by `key`) so the tessellated meshes can be mapped back.
   */
  function toStep(u8) {
    let N;
    try { N = decode(u8).nodes; } catch (e) {
      const m = String((e && e.message) || e);
      throw new Error(/^X_T: /.test(m) ? `X_T 파일을 읽지 못했습니다. 손상되었거나 지원하지 않는 형식입니다 (${m.slice(5)}).` : m);
    }
    const g = (i) => (i ? N.get(i) || null : null);
    /** nodes of a linked chain (start, start.f[next], ...): stops at the end, at a cycle or at a foreign node type */
    const chain = (start, next, type) => {
      const out = [], seen = new Set();
      for (let n = g(start); n && (!type || n.type === type) && !seen.has(n.index); n = g(n.f[next])) { seen.add(n.index); out.push(n); }
      return out;
    };
    const SCALE = 1000; // m -> mm
    const lines = [];
    let id = 0;
    const E = (s) => { lines.push(`#${++id}=${s};`); return `#${id}`; };
    const stats = { bodies: 0, faces: 0, skippedFaces: 0, approxEdges: 0, failedEdges: 0, unsupported: {} };
    const unsupported = (what) => { stats.unsupported[what] = (stats.unsupported[what] || 0) + 1; };

    // ---- attributes: names and colours
    const attrName = (a) => { const d = g(a.f.definition_ref); const idn = d && g(d.f.identifier_ref); return idn ? idn.f.identifier_bytes : ''; };
    const utf8 = (s) => { try { return new TextDecoder('utf-8').decode(Uint8Array.from(s, (c) => c.charCodeAt(0) & 255)); } catch { return s; } };
    const info = new Map(); // owner index -> { name, color }
    for (const a of N.values()) {
      if (a.type !== 81) continue;
      const kind = attrName(a);
      if (!/^SDL\/TYSA_(COLOUR|COLOUR_2|NAME|UNAME)$/.test(kind)) continue;
      const vals = (a.f.value_arrays || []).map(g).filter(Boolean);
      if (!vals.length) continue;
      const o = info.get(a.f.owner_ref) || {};
      if (/COLOUR/.test(kind)) {
        const v = vals[0].type === 83 ? vals[0].f.values : null;
        if (v && v.length >= 3 && v.slice(0, 3).every((x) => x >= 0 && x <= 1)) { if (!o.color || kind === 'SDL/TYSA_COLOUR_2') o.color = v.slice(0, 3); }
      } else {
        const v = vals[0];
        const s = v.type === 98 ? String.fromCharCode(...v.f.values) : v.type === 84 ? utf8(v.f.values) : '';
        if (s && s !== 'NONE' && (kind === 'SDL/TYSA_UNAME' || !o.name)) o.name = s;
      }
      info.set(a.f.owner_ref, o);
    }

    // ---- shared context
    const app = E("APPLICATION_CONTEXT('automotive design')");
    E(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`);
    const pctx = E(`PRODUCT_CONTEXT('',${app},'mechanical')`);
    const pdctx = E(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);
    const mm = E('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
    const rad = E('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
    const sr = E('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())');
    const unc = E(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),${mm},'distance_accuracy_value','')`);
    const ctx = E(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('',''))`);
    const origin = E("AXIS2_PLACEMENT_3D('',#0,$,$)".replace('#0', E("CARTESIAN_POINT('',(0.,0.,0.))")));
    const styleCache = new Map();
    const style = (rgb) => {
      const k = rgb.map((x) => x.toFixed(4)).join(',');
      let s = styleCache.get(k);
      if (!s) {
        const c = E(`COLOUR_RGB('',${rgb.map(R).join(',')})`);
        const fill = E(`FILL_AREA_STYLE('',(${E(`FILL_AREA_STYLE_COLOUR('',${c})`)}))`);
        const side = E(`SURFACE_SIDE_STYLE('',(${E(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`);
        s = E(`PRESENTATION_STYLE_ASSIGNMENT((${E(`SURFACE_STYLE_USAGE(.BOTH.,${side})`)}))`);
        styleCache.set(k, s);
      }
      return s;
    };

    // ---- geometry primitives
    const pt = (p) => E(`CARTESIAN_POINT('',(${R(p[0] * SCALE)},${R(p[1] * SCALE)},${R(p[2] * SCALE)}))`);
    const dir = (d) => { const u = unit(d); return E(`DIRECTION('',(${R(u[0])},${R(u[1])},${R(u[2])}))`); };
    const ax2 = (o, z, x) => {
      const zu = unit(z);
      let xu = sub(x, mul(zu, dot(x, zu))); // make x exactly perpendicular
      if (len(xu) < 1e-12) xu = Math.abs(zu[0]) < 0.9 ? cross(zu, [1, 0, 0]) : cross(zu, [0, 1, 0]);
      return E(`AXIS2_PLACEMENT_3D('',${pt(o)},${dir(zu)},${dir(xu)})`);
    };
    const bspline = (c) => { // 3D curve NURBS (homogeneous when rational)
      const pts = c.P.map((q) => (c.rational ? pt([q[0] / q[3], q[1] / q[3], q[2] / q[3]]) : pt(q)));
      const kn = `(${c.mults.join(',')}),(${c.knots.map(R).join(',')})`;
      if (!c.rational) return E(`B_SPLINE_CURVE_WITH_KNOTS('',${c.p},(${pts.join(',')}),.UNSPECIFIED.,.F.,.F.,${kn},.UNSPECIFIED.)`);
      return E(`(BOUNDED_CURVE() B_SPLINE_CURVE(${c.p},(${pts.join(',')}),.UNSPECIFIED.,.F.,.F.) B_SPLINE_CURVE_WITH_KNOTS(${kn},.UNSPECIFIED.) CURVE() GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE((${c.P.map((q) => R(q[3])).join(',')})) REPRESENTATION_ITEM(''))`);
    };

    // natural-parameter evaluators (meters)
    const nurbsCache = new Map();
    const cNurbs = (cv) => { let c = nurbsCache.get(cv.index); if (!c) { c = curveNurbs(N, g(cv.f.nurbs)); nurbsCache.set(cv.index, c); } return c; };
    const sNurbs = (sf) => { let s = nurbsCache.get(sf.index); if (!s) { s = surfNurbs(N, g(sf.f.nurbs)); nurbsCache.set(sf.index, s); } return s; };
    function curveEval(cv, t) {
      const f = cv.f;
      switch (cv.type) {
        case 30: return add(f.origin, mul(unit(f.direction), t));
        case 31: { const x = unit(f.x_axis), y = cross(unit(f.normal), x); return add(f.center, add(mul(x, f.radius * Math.cos(t)), mul(y, f.radius * Math.sin(t)))); }
        case 32: { const x = unit(f.x_axis), y = cross(unit(f.normal), x); return add(f.center, add(mul(x, f.major_radius * Math.cos(t)), mul(y, f.minor_radius * Math.sin(t)))); }
        case 134: return evalCurveNurbs(cNurbs(cv), t);
        case 133: return curveEval(g(f.basis), t);
        case 137: { const uv = evalCurveNurbs(cNurbs(g(f.pcurve)), t); return surfEval(g(f.surface), uv[0], uv[1]); }
        default: return null;
      }
    }
    function surfEval(sf, u, v) {
      const f = sf.f;
      switch (sf.type) {
        case 50: { const x = unit(f.x_axis), y = cross(unit(f.normal), x); return add(f.origin, add(mul(x, u), mul(y, v))); }
        case 51: { const a = unit(f.axis), x = unit(f.x_axis), y = cross(a, x); return add(add(f.origin, mul(a, v)), add(mul(x, f.radius * Math.cos(u)), mul(y, f.radius * Math.sin(u)))); }
        case 52: {
          const a = unit(f.axis), x = unit(f.x_axis), y = cross(a, x), r = f.radius + v * (f.sin_half_angle / f.cos_half_angle);
          return add(add(f.origin, mul(a, v)), add(mul(x, r * Math.cos(u)), mul(y, r * Math.sin(u))));
        }
        case 53: { const a = unit(f.axis), x = unit(f.x_axis), y = cross(a, x), c = f.radius * Math.cos(v); return add(f.center, add(add(mul(x, c * Math.cos(u)), mul(y, c * Math.sin(u))), mul(a, f.radius * Math.sin(v)))); }
        case 54: {
          const a = unit(f.axis), x = unit(f.x_axis), y = cross(a, x), c = f.major_radius + f.minor_radius * Math.cos(v);
          return add(f.center, add(add(mul(x, c * Math.cos(u)), mul(y, c * Math.sin(u))), mul(a, f.minor_radius * Math.sin(v))));
        }
        case 124: return evalSurfNurbs(sNurbs(sf), u, v);
        case 67: { const c = curveEval(g(f.section), u); return c && add(c, mul(unit(f.sweep), v)); }
        default: return null;
      }
    }
    /** natural parameter range of a curve that has one (B-curves, SP-curves) */
    function curveRange(cv) {
      if (cv.type === 134) { const c = cNurbs(cv); return [c.t0, c.t1]; }
      if (cv.type === 137) { const c = cNurbs(g(cv.f.pcurve)); return [c.t0, c.t1]; }
      if (cv.type === 31 || cv.type === 32) return [0, 2 * Math.PI];
      return null;
    }
    function breakpoints(cv, a, b) {
      let ks = null;
      if (cv.type === 134) ks = cNurbs(cv).knots;
      else if (cv.type === 137) ks = cNurbs(g(cv.f.pcurve)).knots;
      else if (cv.type === 133) return breakpoints(g(cv.f.basis), a, b);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const out = [lo];
      if (ks) for (const k of ks) if (k > lo + 1e-12 && k < hi - 1e-12) out.push(k);
      out.push(hi);
      return out;
    }
    /** adaptive polyline of a curve between natural parameters a -> b */
    const TOL = 1e-6; // 1 µm
    function sampleCurve(cv, a, b) {
      const bp = breakpoints(cv, a, b);
      const pts = [];
      const rec = (t0, p0, t1, p1, depth) => {
        const tm = (t0 + t1) / 2, pm = curveEval(cv, tm);
        if (!pm) throw new Error('eval');
        const ch = sub(p1, p0), l2 = dot(ch, ch);
        const w = sub(pm, p0);
        const dev = l2 > 0 ? len(sub(w, mul(ch, dot(w, ch) / l2))) : len(w);
        if (depth < 12 && (dev > TOL || depth < 2)) { rec(t0, p0, tm, pm, depth + 1); rec(tm, pm, t1, p1, depth + 1); } else pts.push(p1);
      };
      let t0 = bp[0], p0 = curveEval(cv, t0);
      if (!p0) throw new Error('eval');
      pts.push(p0);
      for (let i = 1; i < bp.length; i++) { const p1 = curveEval(cv, bp[i]); if (!p1) throw new Error('eval'); rec(t0, p0, bp[i], p1, 0); t0 = bp[i]; p0 = p1; }
      if (a > b) pts.reverse();
      return pts;
    }
    function chartPoints(cv) { // intersection curve: the chart's points (already within its chordal error)
      const ch = g(cv.f.chart);
      return ch && ch.f.hvecs ? ch.f.hvecs.filter(Boolean).map((h) => h.slice(0, 3)) : null;
    }
    function subPolyline(pts, from, to) { // portion of a polyline between the points nearest to from / to
      const near = (q) => { let bi = 0, bd = Infinity; pts.forEach((p, i) => { const d = dist(p, q); if (d < bd) { bd = d; bi = i; } }); return bi; };
      const i = near(from), j = near(to);
      const out = i <= j ? pts.slice(i, j + 1) : pts.slice(j, i + 1).reverse();
      return out;
    }

    // ---- surfaces
    const surfCache = new Map();
    function surface(sf) {
      if (surfCache.has(sf.index)) return surfCache.get(sf.index);
      const f = sf.f;
      let e = null;
      try {
      switch (sf.type) {
        case 50: e = E(`PLANE('',${ax2(f.origin, f.normal, f.x_axis)})`); break;
        case 51: e = E(`CYLINDRICAL_SURFACE('',${ax2(f.origin, f.axis, f.x_axis)},${R(f.radius * SCALE)})`); break;
        case 52: e = E(`CONICAL_SURFACE('',${ax2(f.origin, f.axis, f.x_axis)},${R(f.radius * SCALE)},${R(Math.atan2(f.sin_half_angle, f.cos_half_angle))})`); break;
        case 53: e = E(`SPHERICAL_SURFACE('',${ax2(f.center, f.axis, f.x_axis)},${R(f.radius * SCALE)})`); break;
        case 54:
          if (f.major_radius > 0) e = E(`TOROIDAL_SURFACE('',${ax2(f.center, f.axis, f.x_axis)},${R(f.major_radius * SCALE)},${R(f.minor_radius * SCALE)})`);
          break;
        case 124: {
          const s = sNurbs(sf);
          const rows = [];
          for (let i = 0; i < s.nu; i++) {
            const row = [];
            for (let j = 0; j < s.nv; j++) { const q = s.P[i * s.nv + j]; row.push(pt(s.rational ? [q[0] / q[3], q[1] / q[3], q[2] / q[3]] : q)); }
            rows.push(`(${row.join(',')})`);
          }
          const kn = `(${s.uk.mults.join(',')}),(${s.vk.mults.join(',')}),(${s.uk.knots.map(R).join(',')}),(${s.vk.knots.map(R).join(',')})`;
          if (!s.rational) e = E(`B_SPLINE_SURFACE_WITH_KNOTS('',${s.pu},${s.pv},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.,${kn},.UNSPECIFIED.)`);
          else {
            const ws = [];
            for (let i = 0; i < s.nu; i++) ws.push(`(${s.P.slice(i * s.nv, i * s.nv + s.nv).map((q) => R(q[3])).join(',')})`);
            e = E(`(BOUNDED_SURFACE() B_SPLINE_SURFACE(${s.pu},${s.pv},(${rows.join(',')}),.UNSPECIFIED.,.F.,.F.,.F.) B_SPLINE_SURFACE_WITH_KNOTS(${kn},.UNSPECIFIED.) GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_SURFACE((${ws.join(',')})) REPRESENTATION_ITEM('') SURFACE())`);
          }
          break;
        }
        case 67: {
          const c = exactCurve(g(f.section));
          if (c) e = E(`SURFACE_OF_LINEAR_EXTRUSION('',${c},${E(`VECTOR('',${dir(f.sweep)},1.)`)})`);
          break;
        }
        case 60: {
          const basis = g(f.basis), b = basis && surface(basis);
          // offset along the basis' (sense-adjusted) normal; STEP offsets along the natural normal
          if (b) e = E(`OFFSET_SURFACE('',${b},${R(f.offset * SCALE * (basis.f.sense === '-' ? -1 : 1))},.F.)`);
          break;
        }
        default: break;
      }
      } catch (err) { e = null; }
      if (!e) unsupported('surface ' + sf.type);
      surfCache.set(sf.index, e);
      return e;
    }

    // ---- curves with an exact STEP form (natural parameterisation)
    const curveCache = new Map();
    function exactCurve(cv) {
      if (!cv) return null;
      if (curveCache.has(cv.index)) return curveCache.get(cv.index);
      const f = cv.f;
      let e = null;
      if (cv.type === 30) e = E(`LINE('',${pt(f.origin)},${E(`VECTOR('',${dir(f.direction)},1.)`)})`);
      else if (cv.type === 31) e = E(`CIRCLE('',${ax2(f.center, f.normal, f.x_axis)},${R(f.radius * SCALE)})`);
      else if (cv.type === 32) e = E(`ELLIPSE('',${ax2(f.center, f.normal, f.x_axis)},${R(f.major_radius * SCALE)},${R(f.minor_radius * SCALE)})`);
      else if (cv.type === 134) { try { if (cNurbs(cv).dim === (cNurbs(cv).rational ? 4 : 3)) e = bspline(cNurbs(cv)); } catch (err) { e = null; } }
      curveCache.set(cv.index, e);
      return e;
    }

    // ---- topology
    const pos = (v) => g(g(v).f.point_ref).f.position;
    const vertCache = new Map();
    const vertex = (v) => { let e = vertCache.get(v); if (!e) { e = E(`VERTEX_POINT('',${pt(pos(v))})`); vertCache.set(v, e); } return e; };
    const polyline = (pts) => E(`POLYLINE('',(${pts.map(pt).join(',')}))`);
    const edgeCache = new Map();
    /** EDGE_CURVE of an XT edge; its direction is the direction of the edge's first fin */
    function edge(ed) {
      if (edgeCache.has(ed.index)) return edgeCache.get(ed.index);
      const f1 = g(ed.f.fin_ref), f2 = f1 && g(f1.f.radial_fin);
      const vE = f1 && f1.f.end_vertex;
      const vS = f2 && f2 !== f1 ? f2.f.end_vertex : f1 && g(f1.f.backward_fin) ? g(f1.f.backward_fin).f.end_vertex : 0;
      let curve = null, same = true, poly = null;
      const cv = g(ed.f.curve_ref);
      try {
        if (cv) {
          const basis = cv.type === 133 ? g(cv.f.basis) : cv;
          const ex = exactCurve(basis);
          if (ex) { curve = ex; same = basis.f.sense !== '-'; }
          else if (basis.type === 38) {
            const ch = chartPoints(basis);
            if (ch && ch.length >= 2) poly = cv.type === 133 ? subPolyline(ch, cv.f.start_point, cv.f.end_point) : basis.f.sense === '-' ? ch.slice().reverse() : ch;
          } else if (basis.type === 137 || basis.type === 134) {
            if (cv.type === 133) poly = sampleCurve(basis, cv.f.start_parameter, cv.f.end_parameter);
            else { const r = curveRange(basis); poly = sampleCurve(basis, basis.f.sense === '-' ? r[1] : r[0], basis.f.sense === '-' ? r[0] : r[1]); }
          } else unsupported('curve ' + basis.type);
        } else {
          // tolerant edge: the geometry lives on the fins (trimmed SP-curves running along their fin)
          let fin = f1;
          for (let k = 0, x = f1; x && k < 8; k++, x = g(x.f.radial_fin)) { if (x.f.curve_ref) { fin = x; break; } if (x.f.radial_fin === f1.index) break; }
          const fc = fin && g(fin.f.curve_ref);
          if (fc && fc.type === 133) {
            poly = sampleCurve(g(fc.f.basis), fc.f.start_parameter, fc.f.end_parameter);
            if (fin.f.sense === '-') poly.reverse();
          } else unsupported('fin curve ' + (fc ? fc.type : 'none'));
        }
      } catch (err) { poly = null; curve = null; }
      if (!curve && !poly) { stats.failedEdges++; edgeCache.set(ed.index, null); return null; }
      let a = vS, b = vE;
      if (poly) {
        stats.approxEdges++;
        if (a && b && a !== b && dist(poly[0], pos(a)) > dist(poly[poly.length - 1], pos(a))) poly.reverse();
        if (a) poly[0] = pos(a);
        if (b) poly[poly.length - 1] = pos(b);
        if (!a) { // ring edge without vertices: a vertex at its start
          const vp = E(`VERTEX_POINT('',${pt(poly[0])})`);
          poly[poly.length - 1] = poly[0];
          curve = polyline(poly);
          const e = E(`EDGE_CURVE('',${vp},${vp},${curve},.T.)`);
          edgeCache.set(ed.index, e);
          return e;
        }
        curve = polyline(poly);
        same = true;
      }
      let va, vb;
      if (a && b) { va = vertex(a); vb = vertex(b); }
      else { // ring edge (closed curve, no vertex)
        const base = cv && cv.type === 133 ? g(cv.f.basis) : cv;
        const r = base && curveRange(base);
        const p0 = base && curveEval(base, r ? r[0] : 0);
        if (!p0) { stats.failedEdges++; edgeCache.set(ed.index, null); return null; }
        va = vb = E(`VERTEX_POINT('',${pt(p0)})`);
      }
      const e = E(`EDGE_CURVE('',${va},${vb},${curve},${same ? '.T.' : '.F.'})`);
      edgeCache.set(ed.index, e);
      return e;
    }
    function face(fc) {
      const sf = g(fc.f.surface_ref);
      const surf = sf && surface(sf);
      if (!surf) return null;
      const bounds = [];
      for (const lp of chain(fc.f.loop_head, 'next_loop', 15)) {
        const oes = [];
        let ok = true;
        for (const fin of chain(lp.f.fin_ref, 'forward_fin', 17)) {
          if (!fin.f.edge_ref) continue;
          const ed = g(fin.f.edge_ref);
          const e = ed && ed.type === 16 ? edge(ed) : null;
          if (!e) { ok = false; break; }
          oes.push(E(`ORIENTED_EDGE('',*,*,${e},${fin.f.sense === '-' ? '.F.' : '.T.'})`));
        }
        if (!ok) return null;
        if (oes.length) bounds.push(E(`FACE_BOUND('',${E(`EDGE_LOOP('',(${oes.join(',')}))`)},.T.)`));
      }
      return E(`ADVANCED_FACE('',(${bounds.join(',')}),${surf},${fc.f.sense === sf.f.sense ? '.T.' : '.F.'})`);
    }

    // ---- bodies
    const bodies = [];
    let bodyNo = 0;
    for (const body of N.values()) {
      if (body.type !== 12) continue;
      bodyNo++;
      try {
      const solid = body.f.body_kind === 1;
      const meta = info.get(body.index) || {};
      const shells = [];
      const seen = new Set();
      const seenShells = new Set();
      for (const rg of chain(body.f.region_head, 'next_region', 19)) {
        if (solid && rg.f.region_kind !== 'S') continue;
        for (const sh of chain(rg.f.shell_head, 'next_shell', 13)) {
          if (seenShells.has(sh.index)) continue;
          seenShells.add(sh.index);
          const fl = [];
          for (const [head, next] of [['back_faces', 'next_back'], ['front_faces', 'next_front']]) {
            for (const fc of chain(sh.f[head], next, 14)) { if (!seen.has(fc.index)) { seen.add(fc.index); fl.push(fc); } }
          }
          if (fl.length) shells.push(fl);
        }
      }
      if (!shells.length) continue;
      const items = [], styled = [];
      let sheet = false;
      const bodyColor = meta.color || null;
      for (const fl of shells) {
        const fe = [];
        let skipped = 0;
        for (const fc of fl) {
          stats.faces++;
          const e = face(fc);
          if (!e) { skipped++; stats.skippedFaces++; continue; }
          fe.push(e);
          const fcol = (info.get(fc.index) || {}).color;
          if (fcol && (!bodyColor || fcol.some((x, i) => Math.abs(x - bodyColor[i]) > 1e-3))) styled.push(E(`STYLED_ITEM('',(${style(fcol)}),${e})`));
        }
        if (!fe.length) continue;
        if (solid && !skipped) items.push(E(`MANIFOLD_SOLID_BREP('',${E(`CLOSED_SHELL('',(${fe.join(',')}))`)})`));
        else { sheet = true; items.push(E(`SHELL_BASED_SURFACE_MODEL('',(${E(`OPEN_SHELL('',(${fe.join(',')}))`)}))`)); }
      }
      if (!items.length) continue;
      stats.bodies++;
      const key = `XTB${bodyNo}`;
      if (bodyColor) for (const it of items) styled.push(E(`STYLED_ITEM('',(${style(bodyColor)}),${it})`));
      const prod = E(`PRODUCT(${S(key)},${S(key)},'',(${pctx}))`);
      const pd = E(`PRODUCT_DEFINITION('design','',${E(`PRODUCT_DEFINITION_FORMATION('','',${prod})`)},${pdctx})`);
      const rep = E(`${sheet ? 'SHAPE_REPRESENTATION' : 'ADVANCED_BREP_SHAPE_REPRESENTATION'}('',(${[...items, origin].join(',')}),${ctx})`);
      E(`SHAPE_DEFINITION_REPRESENTATION(${E(`PRODUCT_DEFINITION_SHAPE('','',${pd})`)},${rep})`);
      if (styled.length) E(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),${ctx})`);
      bodies.push({ key, name: meta.name || '', color: bodyColor, solid });
      } catch (err) { stats.failedBodies = (stats.failedBodies || 0) + 1; stats.lastError = String(err && err.message || err); }
    }
    if (!bodies.length) throw new Error('X_T 파일에서 표시할 형상(바디)을 찾지 못했습니다.');
    const step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('StepViewer X_T conversion'),'2;1');\nFILE_NAME('x_t','',(''),(''),'StepViewer','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
    return { step, bodies, stats };
  }

  const API = { decode, toStep, BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else G.XTFile = API;
})(typeof self !== 'undefined' ? self : globalThis);
