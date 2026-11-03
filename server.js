// StepViewer launcher / local server.
// - Serves the web app (from embedded SEA assets when packaged, from disk in dev).
// - Opens the app in a chromeless browser window (Edge/Chrome --app mode, falls back to default browser).
// - Single instance: a second launch forwards its file arguments to the running instance.
// - Exits automatically when the last viewer window is closed.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const APP_ID = 'stepviewer-1';
const PREFERRED_PORT = 47831;
const LOG_FILE = path.join(os.tmpdir(), 'StepViewer.log');

let sea = null;
try {
  sea = require('node:sea');
  if (!sea.isSea()) sea = null;
} catch { sea = null; }

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  if (!sea) process.stdout.write(line);
}

const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const assetCache = new Map();
function getAsset(rel) {
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('..')) return null;
  if (assetCache.has(rel)) return assetCache.get(rel);
  let buf = null;
  if (sea) {
    try { buf = Buffer.from(sea.getAsset('app/' + rel)); } catch { buf = null; }
  } else {
    const p = path.join(APP_DIR, rel);
    if (p.startsWith(APP_DIR) && fs.existsSync(p) && fs.statSync(p).isFile()) buf = fs.readFileSync(p);
  }
  if (buf && sea) assetCache.set(rel, buf); // only cache when packaged (dev = live reload from disk)
  return buf;
}

/** Build id = hash of the app files. The app is served under /b/<id>/ so every build has URLs the
 *  browser has never cached (files cached by an older exe can't shadow the new ones). */
let buildId = null;
function getBuildId() {
  if (buildId) return buildId;
  if (!sea) return (buildId = 'dev');
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'main.js', 'worker.js', 'swfile.js', 'style.css', 'vendor/three.module.js', 'vendor/three.core.js',
    'vendor/three-mesh-bvh.module.js', 'vendor/occt-import-js.js', 'vendor/addons/OrbitControls.js', 'vendor/addons/CSS2DRenderer.js']) {
    const b = getAsset(f);
    h.update(f).update(b || '');
  }
  return (buildId = h.digest('hex').slice(0, 12));
}
const appUrl = (base) => `${base}b/${getBuildId()}/`;

const etags = new Map();
function assetEtag(rel, buf) {
  if (sea && etags.has(rel)) return etags.get(rel);
  const tag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"';
  if (sea) etags.set(rel, tag);
  return tag;
}

// ---- files passed on the command line / forwarded from other instances ----
const STEP_EXT = /\.(step|stp|iges|igs|brep|brp|sldprt|sldasm)$/i;
const fileRegistry = new Map(); // id -> absolute path
let nextFileId = 1;
const pendingOpen = []; // ids not yet delivered to any client

function registerFiles(paths) {
  const ids = [];
  for (const raw of paths) {
    if (!raw) continue;
    const p = path.resolve(raw);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch { log('missing file', p); continue; }
    const id = String(nextFileId++);
    fileRegistry.set(id, p);
    ids.push(id);
  }
  return ids;
}

/** Find a file referenced by an assembly next to it. SolidWorks keeps the original reference names
 *  (e.g. "rear container.SLDPRT") while Pack and Go adds suffixes ("rear container_261022.SLDPRT"),
 *  so an exact (case-insensitive) match is tried first, then "<stem>[_ -]<anything>.<same ext>". */
function findSibling(dir, want) {
  if (!want || /[\\/:]/.test(want) || want.includes('..') || !STEP_EXT.test(want)) return null;
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const w = want.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === w);
  if (exact) return path.join(dir, exact);
  const ext = path.extname(w), stem = w.slice(0, -ext.length);
  const cands = names.filter((n) => {
    const l = n.toLowerCase();
    return l.endsWith(ext) && l.length > w.length && l.startsWith(stem) && '_ -'.includes(l[stem.length]);
  }).sort((a, b) => a.length - b.length);
  return cands.length ? path.join(dir, cands[0]) : null;
}

function fileInfo(id) {
  const p = fileRegistry.get(id);
  let size = 0, mtime = 0;
  try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
  return { id, name: path.basename(p), size, mtime };
}

// ---- SSE clients (used for liveness + push "open file" events) ----
const clients = new Set();
let everConnected = false;
let exitTimer = null;

function broadcastOpen(ids) {
  if (!ids.length) return;
  if (clients.size === 0) { pendingOpen.push(...ids); return false; }
  const payload = `event: openfiles\ndata: ${JSON.stringify(ids.map(fileInfo))}\n\n`;
  for (const res of clients) res.write(payload);
  return true;
}

function scheduleExitCheck() {
  clearTimeout(exitTimer);
  if (clients.size > 0) return;
  exitTimer = setTimeout(() => {
    if (clients.size === 0 && everConnected) {
      log('no viewer windows left, exiting');
      process.exit(0);
    }
  }, 8000);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => { total += c.length; if (total > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(initialIds) {
  pendingOpen.push(...initialIds);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/api/hello') return json(res, 200, { app: APP_ID, pid: process.pid });

      if (p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        req.socket.setTimeout(0);
        clients.add(res);
        everConnected = true;
        clearTimeout(exitTimer);
        if (pendingOpen.length) {
          const ids = pendingOpen.splice(0);
          res.write(`event: openfiles\ndata: ${JSON.stringify(ids.map(fileInfo))}\n\n`);
        }
        const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); scheduleExitCheck(); });
        return;
      }

      if (p === '/api/open' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ids = registerFiles(Array.isArray(body.paths) ? body.paths : []);
        const delivered = clients.size > 0;
        if (delivered) broadcastOpen(ids); else { pendingOpen.push(...ids); openBrowser(appUrl(serverUrl)); }
        return json(res, 200, { ok: true, ids, delivered });
      }

      if (p === '/api/focus' && req.method === 'POST') {
        if (clients.size === 0) openBrowser(appUrl(serverUrl));
        for (const c of clients) c.write('event: focus\ndata: {}\n\n');
        return json(res, 200, { ok: true });
      }

      const sib = /^\/api\/sibling\/(\d+)$/.exec(p);
      if (sib) {
        const owner = fileRegistry.get(sib[1]);
        if (!owner) return json(res, 404, { error: 'unknown file' });
        let fp = findSibling(path.dirname(owner), url.searchParams.get('name') || '');
        if (fp) { // no links/junctions out of the folder: the real path must be a regular file in the owner's real folder
          try {
            const real = fs.realpathSync(fp);
            if (path.dirname(real).toLowerCase() !== fs.realpathSync(path.dirname(owner)).toLowerCase() || !fs.statSync(real).isFile()) fp = null;
            else fp = real;
          } catch { fp = null; }
        }
        if (!fp) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); } // not an error: optional reference
        const st = fs.statSync(fp);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-File-Name': encodeURIComponent(path.basename(fp)) });
        fs.createReadStream(fp).pipe(res);
        return;
      }

      const m = /^\/api\/file\/(\d+)$/.exec(p);
      if (m) {
        const fp = fileRegistry.get(m[1]);
        if (!fp) return json(res, 404, { error: 'unknown file' });
        const st = fs.statSync(fp);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
        fs.createReadStream(fp).pipe(res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      if (p === '/' || p === '/index.html') { res.writeHead(302, { Location: `/b/${getBuildId()}/`, 'Cache-Control': 'no-store' }); return res.end(); }
      const bm = /^\/b\/[\w-]+(\/.*)$/.exec(p);
      const assetPath = bm ? bm[1] : p;
      const buf = getAsset(assetPath);
      if (!buf) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(assetPath.endsWith('/') ? 'index.html' : assetPath).toLowerCase() || '.html';
      // content ETag + no-cache: the browser revalidates every load (cheap 304), so a rebuilt exe is
      // never shadowed by app files cached from an older version
      const etag = assetEtag(assetPath, buf);
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': sea ? 'no-cache' : 'no-store',
        ETag: etag,
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    } catch (e) {
      log('request error', p, e && e.stack);
      if (!res.headersSent) json(res, 500, { error: String(e) });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5000;
  server.requestTimeout = 0;
  return server;
}

// ---- browser launching ----
function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
}

let serverUrl = '';
function openBrowser(url) {
  if (process.env.STEPVIEWER_NO_BROWSER === '1') return;
  const browser = findBrowser();
  try {
    if (browser) {
      const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'StepViewer', 'profile');
      spawn(browser, [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        '--disable-features=CalculateNativeWinOcclusion',
      ], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    log('opened browser', browser || 'default', url);
  } catch (e) {
    log('failed to open browser', e && e.message);
  }
}

// ---- single instance handling ----
function request(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, timeout: 1500,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// Instance file lets a second launch find us even when we had to fall back to a random port.
const INSTANCE_FILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'StepViewer', 'instance.json');
function readInstancePort() {
  try { return JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')).port || null; } catch { return null; }
}
function writeInstanceFile(port) {
  try {
    fs.mkdirSync(path.dirname(INSTANCE_FILE), { recursive: true });
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ port, pid: process.pid }));
    process.on('exit', () => {
      try { if (JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(INSTANCE_FILE); } catch { /* ignore */ }
    });
  } catch (e) { log('instance file write failed', e.message); }
}

// Atomic startup lock: exactly one of several simultaneous launches becomes the server.
const LOCK_FILE = path.join(path.dirname(INSTANCE_FILE), 'instance.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', () => { try { if (fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // can't lock at all -> just run
      let pid = 0;
      try { pid = Number(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { /* ignore */ }
      if (pid && pidAlive(pid)) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } // stale lock
    }
  }
  return false;
}

async function findRunning(ports) {
  for (const p of ports) {
    if (!p) continue;
    const hello = await request(p, 'GET', '/api/hello');
    if (hello && hello.app === APP_ID) return p;
  }
  return null;
}

async function forwardTo(port, files) {
  const absPaths = files.map((f) => path.resolve(f));
  if (absPaths.length) await request(port, 'POST', '/api/open', { paths: absPaths });
  else await request(port, 'POST', '/api/focus');
  log('forwarded to running instance on', port, absPaths.join(', '));
  process.exit(0);
}

async function main() {
  const self = new Set([process.execPath, __filename].map((p) => path.resolve(p).toLowerCase()));
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--') && !self.has(path.resolve(a).toLowerCase()));
  const files = args.filter((a) => STEP_EXT.test(a));
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const explicitPort = !!portArg; // explicit port (tests/dev) = isolated instance, no single-instance discovery
  const port = explicitPort ? Number(portArg.split('=')[1]) : PREFERRED_PORT;

  // Another instance running? Forward files to it and quit.
  const running = await findRunning(explicitPort ? [port] : [port, readInstancePort()]);
  if (running) return forwardTo(running, files);
  if (!explicitPort && !acquireLock()) {
    // another launch is starting up right now: wait for it, then hand over our files
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const p = await findRunning([port, readInstancePort()]);
      if (p) return forwardTo(p, files);
    }
    log('lock holder never came up, starting standalone');
  }

  const server = createServer(registerFiles(files));
  let actualPort;
  try {
    actualPort = await listen(server, port);
  } catch (e) {
    // Lost a race with a simultaneous launch (e.g. several files opened at once from Explorer)?
    for (let i = 0; i < 10; i++) {
      const p = await findRunning([port, explicitPort ? null : readInstancePort()]);
      if (p) return forwardTo(p, files);
      await new Promise((r) => setTimeout(r, 150));
    }
    log('preferred port busy (another program), using random port', e.code);
    actualPort = await listen(server, 0);
  }
  if (!explicitPort) writeInstanceFile(actualPort);
  serverUrl = `http://127.0.0.1:${actualPort}/`;
  log('StepViewer listening on', serverUrl, sea ? '(packaged)' : '(dev)');
  openBrowser(appUrl(serverUrl));

  // If no window ever connects (browser failed to open), don't linger forever.
  setTimeout(() => {
    if (!everConnected && process.env.STEPVIEWER_KEEPALIVE !== '1') { log('no client connected in 120s, exiting'); process.exit(0); }
  }, 120000);
}

process.on('uncaughtException', (e) => log('uncaught', e && e.stack));
main();
