// MCP server (stdio) for StepViewer: `StepViewer.exe --mcp` (or `node server.js --mcp` in development).
// It finds the running viewer (or starts it), and sends each tool call to the viewer window through the local
// server's automation bridge (/api/rpc). Only Node built-ins: this file is embedded in the single exe.
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout; nothing else may be written to stdout.
'use strict';
const http = require('node:http');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TAB = { type: 'string', description: 'Tab name as listed by viewer_status, or "#<index>". Default: the active tab. A given tab becomes the active one.' };
const PARTS = { type: 'array', items: { type: 'string' }, description: 'Part names (or URDF link names: all parts of the link), as listed by get_model.' };
const TOOLS = [
  {
    name: 'viewer_status',
    description: 'Open tabs in StepViewer (name, part and triangle counts, bounding box in mm, robot joints). Starts the viewer when it is not running.',
    inputSchema: { type: 'object', properties: {} },
    cmd: 'status',
  },
  {
    name: 'open_files',
    description: 'Open CAD files in the viewer: STEP/IGES/BREP, SolidWorks SLDPRT/SLDASM, Parasolid X_T, URDF, STL/OBJ. Absolute paths. Files referenced by an assembly or URDF are found next to it; when given together with it they are only used as its references. Returns the opened tabs and any warnings.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute file paths' } }, required: ['paths'] },
    cmd: 'open', timeout: 1800000,
  },
  {
    name: 'manage_tab',
    description: 'Activate or close a tab.',
    inputSchema: { type: 'object', properties: { tab: TAB, action: { type: 'string', enum: ['activate', 'close'] } }, required: ['tab', 'action'] },
    cmd: 'tab',
  },
  {
    name: 'get_model',
    description: 'Parts of a tab: name, URDF link, visibility, selection, triangles and bounding box (mm, world coordinates in the current pose).',
    inputSchema: { type: 'object', properties: { tab: TAB, filter: { type: 'string', description: 'Case-insensitive substring of the part or link name' }, limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 200' } } },
    cmd: 'model',
  },
  {
    name: 'get_joints',
    description: 'Joints of a URDF robot tab: type, current value, URDF limits and the usable range (deg for revolute/continuous, mm for prismatic), home value, parent/child link, axis, mimic relation.',
    inputSchema: { type: 'object', properties: { tab: TAB } },
    cmd: 'joints',
  },
  {
    name: 'set_joints',
    description: 'Move joints of a URDF robot (values in deg for revolute/continuous, mm for prismatic). Values outside the usable range are clamped (reported in "clamped"); with ignore_limits true any value is taken as given. Mimic joints follow their master and cannot be set. Returns all joint values after the move.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        values: { type: 'object', additionalProperties: { type: 'number' }, description: 'Joint name -> value, e.g. {"index_mcp": 45}' },
        reset: { type: 'boolean', description: 'First return every joint to its home value' },
        ignore_limits: { type: 'boolean', description: 'Lift (true) or restore (false) the URDF limits, like the "한계 무시" checkbox' },
      },
    },
    cmd: 'set_joints',
  },
  {
    name: 'set_view',
    description: 'Point the camera: a standard view (Z up) fitted to the whole model or to the given parts; "fit" keeps the direction.',
    inputSchema: { type: 'object', properties: { tab: TAB, view: { type: 'string', enum: ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom', 'fit'] }, parts: PARTS }, required: ['view'] },
    cmd: 'view',
  },
  {
    name: 'set_visibility',
    description: 'Show or hide parts: "show"/"hide" the given parts, "only" shows just them, "all" shows everything.',
    inputSchema: { type: 'object', properties: { tab: TAB, action: { type: 'string', enum: ['show', 'hide', 'only', 'all'] }, parts: PARTS }, required: ['action'] },
    cmd: 'visibility',
  },
  {
    name: 'select_parts',
    description: 'Select parts (highlighted; the properties panel shows them). An empty list clears the selection.',
    inputSchema: { type: 'object', properties: { tab: TAB, parts: PARTS }, required: ['parts'] },
    cmd: 'select',
  },
  {
    name: 'set_section',
    description: 'Section view with a plane normal to x, y or z at a position in mm (world coordinates); "off" removes all section planes. Returns each axis state and its range.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        axis: { type: 'string', enum: ['x', 'y', 'z', 'off'] },
        enabled: { type: 'boolean', description: 'Default true' },
        position_mm: { type: 'number' },
        flip: { type: 'boolean', description: 'Which side is cut away' },
        caps: { type: 'boolean', description: 'Fill the cut faces' },
      },
      required: ['axis'],
    },
    cmd: 'section',
  },
  {
    name: 'screenshot',
    description: 'PNG image of the 3D view of a tab as it is shown now (camera, pose, visibility, section).',
    inputSchema: { type: 'object', properties: { tab: TAB, max_size: { type: 'integer', minimum: 64, maximum: 4096, description: 'Longest side in pixels (default 1280)' } } },
    cmd: 'screenshot',
  },
];

/** the subset of JSON Schema the tools use; returns what is wrong, or null. Unknown properties are errors
 *  (a misspelt argument would otherwise be ignored silently). */
function invalid(schema, v, at) {
  const t = schema.type;
  if (t === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} must be an object`;
    for (const r of schema.required || []) if (!Object.prototype.hasOwnProperty.call(v, r) || v[r] === undefined) return `${at}.${r} is required`;
    for (const [k, x] of Object.entries(v)) {
      // own properties only: 'constructor', 'toString' ... of the schema object are not arguments
      const sub = (schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, k) ? schema.properties[k] : null)
        || (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (!sub) return `${at}.${k} is not a known argument`;
      const e = invalid(sub, x, `${at}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(v)) return `${at} must be an array`;
    if (schema.minItems && v.length < schema.minItems) return `${at} needs at least ${schema.minItems} item(s)`;
    for (let i = 0; i < v.length; i++) { const e = schema.items && invalid(schema.items, v[i], `${at}[${i}]`); if (e) return e; }
    return null;
  }
  if (t === 'string' && typeof v !== 'string') return `${at} must be a string`;
  if (t === 'boolean' && typeof v !== 'boolean') return `${at} must be true or false`;
  if ((t === 'number' || t === 'integer') && (typeof v !== 'number' || !Number.isFinite(v))) return `${at} must be a number`;
  if (t === 'integer' && !Number.isInteger(v)) return `${at} must be an integer`;
  if (schema.minimum !== undefined && v < schema.minimum) return `${at} must be >= ${schema.minimum}`;
  if (schema.maximum !== undefined && v > schema.maximum) return `${at} must be <= ${schema.maximum}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at} must be one of ${schema.enum.join(', ')}`;
  return null;
}

const INSTRUCTIONS = 'StepViewer shows CAD models (STEP, SolidWorks, Parasolid, URDF robots, STL/OBJ) in a window on this PC. '
  + 'Start with viewer_status or open_files (absolute paths). Units are mm and degrees. For URDF robots use get_joints, then set_joints; '
  + 'check the result with screenshot. Commands act on the window the user used last.';

module.exports = function runMcp(ctx) {
  // ctx: { version, findPort(): Promise<port|null>, launch(): bool (false = may not start the viewer), log(msg) }
  let port = null;
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  /** POST to the viewer; `signal` (AbortSignal) drops the request, which makes the server drop the command */
  function post(p, pathName, body, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: pathName, timeout: timeoutMs, signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-StepViewer': '1' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 404) return reject(new Error('the running StepViewer is an older version without automation: close it and try again.'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error(`bad answer (${res.statusCode})`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(data);
    });
  }

  async function viewerPort(signal) {
    if (port && await ctx.findPort(port)) return port;
    port = await ctx.findPort();
    if (port) return port;
    if (signal.aborted) throw new Error('cancelled');
    if (!ctx.launch()) throw new Error('StepViewer is not running.');
    for (let i = 0; i < 100 && !port && !signal.aborted; i++) { await new Promise((r) => setTimeout(r, 200)); port = await ctx.findPort(); }
    if (!port) throw new Error(signal.aborted ? 'cancelled' : 'StepViewer did not start.');
    return port;
  }

  async function callTool(tool, args, signal) {
    let ans;
    try {
      const p = await viewerPort(signal);
      const timeout = tool.timeout || 120000;
      ans = await post(p, '/api/rpc', { cmd: tool.cmd, args, timeout_ms: timeout }, timeout + 35000, signal);
    } catch (e) {
      return { content: [{ type: 'text', text: `StepViewer: ${e.message}` }], isError: true };
    }
    if (!ans.ok) return { content: [{ type: 'text', text: JSON.stringify({ error: ans.error, rejected: ans.rejected }) }], isError: true };
    const r = ans.result;
    if (tool.cmd === 'screenshot') {
      return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ tab: r.tab, width: r.width, height: r.height }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(ans.rejected ? { ...r, rejected: ans.rejected } : r) }] };
  }

  const inflight = new Map(); // request id -> AbortController (notifications/cancelled)
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));

  async function handle(msg) {
    const isObj = msg && typeof msg === 'object' && !Array.isArray(msg);
    // responses to us (exactly one of result / error): we send no requests, so a well-formed one is ignored
    if (isObj && msg.jsonrpc === '2.0' && !own(msg, 'method') && !own(msg, 'params') && validId(msg.id) && own(msg, 'result') !== own(msg, 'error')) return;
    // anything else must be a request (valid id) or a notification (no id at all): JSON-RPC 2.0, a method,
    // params (if any) an object, and no response fields
    if (!isObj || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || (own(msg, 'id') && !validId(msg.id))
      || own(msg, 'result') || own(msg, 'error')
      || (own(msg, 'params') && (!msg.params || typeof msg.params !== 'object' || Array.isArray(msg.params)))) {
      return send({ jsonrpc: '2.0', id: isObj && validId(msg.id) ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const { method } = msg;
    const params = msg.params || {};
    if (!own(msg, 'id')) { // notifications
      if (method === 'notifications/cancelled' && validId(params.requestId) && inflight.has(params.requestId)) {
        inflight.get(params.requestId).abort();
        inflight.delete(params.requestId); // a cancelled request gets no response
      }
      return;
    }
    const id = msg.id;
    const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      let result;
      if (method === 'tools/call') {
        const tool = typeof params.name === 'string' ? TOOLS.find((t) => t.name === params.name) : null;
        if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        const bad = invalid(tool.inputSchema, args, 'arguments');
        if (bad) return fail(-32602, `Invalid arguments for ${tool.name}: ${bad}`);
        const ac = new AbortController();
        inflight.set(id, ac);
        try { result = await callTool(tool, args, ac.signal); } finally { if (inflight.get(id) === ac) inflight.delete(id); }
        if (ac.signal.aborted) return;
      } else if (method === 'initialize') {
        const want = params.protocolVersion;
        result = { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'stepviewer', title: 'StepViewer', version: ctx.version }, instructions: INSTRUCTIONS };
      } else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      else return fail(-32601, `Method not found: ${method}`);
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      fail(-32603, e.message);
    }
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      handle(msg); // (JSON-RPC batches are not part of MCP 2025-06-18: an array is an invalid request)
    }
  });
  process.stdin.on('end', () => process.exit(0));
  ctx.log(`MCP server ready (${ctx.version})`);
};
