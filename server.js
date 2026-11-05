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
const REPO = 'David-K6/StepViewer'; // GitHub releases: tag = version, asset StepViewer.exe
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
  const h = crypto.createHash('sha1').update(getVersion());
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

// ---- version + self update ----
let version = null;
function getVersion() {
  if (version) return version;
  try {
    const pkg = sea ? JSON.parse(Buffer.from(sea.getAsset('package.json')).toString('utf8')) : require('./package.json');
    version = String(pkg.version);
  } catch { version = '0.0.0'; }
  return version;
}
/** numeric compare of "1.2.3" / "v1.2.3" (missing parts = 0) */
function compareVersions(a, b) {
  const pa = String(a).trim().replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).trim().replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
const RELEASE_API = process.env.STEPVIEWER_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
async function latestRelease() {
  const r = await fetch(RELEASE_API, { headers: { 'User-Agent': 'StepViewer', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
  const j = await r.json();
  const asset = (j.assets || []).find((a) => String(a.name).toLowerCase() === 'stepviewer.exe');
  return {
    version: String(j.tag_name || '').replace(/^v/i, ''), url: j.html_url || RELEASES_PAGE, notes: j.body || '', published: j.published_at || null,
    asset: asset ? { url: asset.browser_download_url, size: asset.size } : null,
  };
}
/** the exe to replace: the running one when packaged (STEPVIEWER_UPDATE_EXE only for tests of the dev build) */
const updateTarget = () => (sea ? process.execPath : process.env.STEPVIEWER_UPDATE_EXE || null);
const upd = { phase: 'idle', received: 0, total: 0, error: null, version: null };

const STALL_MS = 30000;
let updAbort = null;
/** run the downloaded exe with --sv-check-version: it exits 0 only if it starts and is that version */
function checkExe(file, ver) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let child;
    try { child = spawn(file, [`--sv-check-version=${ver}`], { stdio: 'ignore', windowsHide: true }); } catch { return finish(false); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, 30000);
    child.once('error', () => { clearTimeout(t); finish(false); });
    child.once('exit', (code) => { clearTimeout(t); finish(code === 0); });
  });
}
function rm(f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

async function runUpdate() {
  const exe = updateTarget();
  upd.error = null;
  const tmp = exe ? exe + '.download' : null, old = exe ? exe + '.old' : null;
  let swapped = false;
  try {
    if (!exe) throw new Error('개발 모드에서는 자동 업데이트를 할 수 없습니다.');
    upd.phase = 'checking';
    const rel = await latestRelease();
    if (compareVersions(rel.version, getVersion()) <= 0) throw new Error('이미 최신 버전입니다.');
    if (!rel.asset) throw new Error('릴리즈에 StepViewer.exe 파일이 없습니다.');
    Object.assign(upd, { phase: 'downloading', received: 0, total: rel.asset.size || 0, version: rel.version });
    updAbort = new AbortController();
    let stall = null;
    const kick = () => { clearTimeout(stall); stall = setTimeout(() => updAbort.abort(new Error('다운로드가 30초 동안 멈췄습니다.')), STALL_MS); };
    kick();
    try {
      const res = await fetch(rel.asset.url, { headers: { 'User-Agent': 'StepViewer', Accept: 'application/octet-stream' }, redirect: 'follow', signal: updAbort.signal });
      if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
      const fh = await fs.promises.open(tmp, 'w');
      try {
        for await (const chunk of res.body) {
          kick();
          await fh.write(chunk);
          upd.received += chunk.length;
        }
      } finally { await fh.close(); }
    } catch (e) {
      const reason = updAbort.signal.aborted ? updAbort.signal.reason : e;
      throw new Error(reason && reason.message === 'cancelled' ? '업데이트를 취소했습니다.' : `다운로드 실패: ${(reason && reason.message) || reason}`);
    } finally { clearTimeout(stall); updAbort = null; }
    // validate the complete file: size, PE header, and that it actually runs as the expected version
    const size = fs.statSync(tmp).size;
    const head = Buffer.alloc(2);
    const fd = fs.openSync(tmp, 'r');
    try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
    if ((rel.asset.size && size !== rel.asset.size) || head.toString('latin1') !== 'MZ') throw new Error('받은 파일이 올바르지 않습니다 (크기/형식 불일치).');
    upd.phase = 'verifying';
    if (!(await checkExe(tmp, rel.version))) throw new Error('받은 파일을 실행할 수 없거나 버전이 다릅니다.');
    // a running exe can be renamed (not overwritten): move it aside, put the new one in its place
    rm(old);
    try { fs.renameSync(exe, old); } catch (e) {
      throw new Error(`실행 파일을 바꿀 수 없습니다 (${e.code || e.message}). 쓰기 권한이 있는 폴더로 옮기거나 릴리즈 페이지에서 직접 받아 주세요.`);
    }
    try { fs.renameSync(tmp, exe); } catch (e) {
      swapped = true; // the catch below puts the previous exe back (with retries) and reports whether that worked
      throw new Error(`새 실행 파일을 놓지 못했습니다 (${e.code || e.message})`);
    }
    swapped = true;
    upd.phase = 'restarting';
    log('updated', getVersion(), '->', rel.version, exe);
    // let the window read the 'restarting' state, then hand over to the new exe (it waits for this pid to exit)
    await new Promise((r) => setTimeout(r, 700));
    const keep = process.argv.slice(sea ? 1 : 2).filter((a) => a.startsWith('--port=')); // isolated test instances keep their port
    await new Promise((resolve, reject) => {
      let child;
      try { child = spawn(exe, [...keep, `--after-update=${process.pid}`], { detached: true, stdio: 'ignore', env: process.env }); } catch (e) { return reject(e); }
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    process.exit(0);
  } catch (e) {
    if (swapped) { // the new exe did not start: put the old one back (a lock may be short-lived -> retry)
      let restored = false, why = '';
      for (let i = 0; i < 6 && !restored; i++) {
        if (i) await new Promise((r) => setTimeout(r, 500));
        try {
          if (fs.existsSync(exe)) { rm(tmp); fs.renameSync(exe, tmp); }
          fs.renameSync(old, exe);
          restored = true;
        } catch (re) { why = re.code || re.message; }
      }
      log(restored ? 'restored previous exe' : `restore failed ${why}`);
      e = restored
        ? new Error(`업데이트를 마치지 못해 이전 버전으로 되돌렸습니다 (${e.code || e.message}).`)
        : new Error(`업데이트를 마치지 못했고 이전 버전으로 되돌리지도 못했습니다 (${why}). 이전 실행 파일은 "${old}"에 있습니다. `
          + `StepViewer를 종료한 뒤 이 파일의 이름을 "${path.basename(exe)}"(으)로 바꾸거나 릴리즈 페이지에서 다시 받아 주세요.`);
      if (!restored) { upd.phase = 'error'; upd.error = e.message; log('update failed', upd.error); return; } // keep the new file for inspection
    }
    if (tmp && fs.existsSync(tmp)) rm(tmp);
    upd.phase = 'error';
    upd.error = e.message || String(e);
    log('update failed', upd.error);
  }
}

// ---- saving exports ----
function defaultSaveDir() {
  for (const d of [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Documents'), os.homedir()]) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch { /* next */ }
  }
  return os.homedir();
}
const SAVE_EXT = /\.(dxf)$/i;
/** write an export: only a plain file name with an allowed extension, into an existing absolute folder */
function saveExport(body) {
  const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!dir || !path.isAbsolute(dir)) return { error: '저장 폴더는 전체 경로(예: C:\\Users\\...\\Documents)로 입력해 주세요.' };
  if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return { error: '파일 이름에 사용할 수 없는 문자가 있습니다 ( \\ / : * ? " < > | ).' };
  if (!SAVE_EXT.test(name)) return { error: '파일 이름은 .dxf로 끝나야 합니다.' };
  if (typeof body.content !== 'string') return { error: '저장할 내용이 없습니다.' };
  try { if (!fs.statSync(dir).isDirectory()) return { error: `폴더가 아닙니다: ${dir}` }; } catch { return { error: `폴더를 찾을 수 없습니다: ${dir}` }; }
  const file = path.join(dir, name);
  try {
    if (!body.overwrite) fs.writeFileSync(file, body.content, { encoding: 'utf8', flag: 'wx' });
    else {
      // write a new file and rename it over the old name: a hard link or symlink at that name is replaced,
      // the file it pointed to is never written
      let st = null;
      try { st = fs.lstatSync(file); } catch { /* gone meanwhile */ }
      if (st && st.isDirectory()) return { error: `같은 이름의 폴더가 있습니다: ${name}` };
      const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, body.content, { encoding: 'utf8', flag: 'wx' });
      try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    }
  } catch (e) {
    if (e.code === 'EEXIST') return { error: `같은 이름의 파일이 이미 있습니다: ${name}`, exists: true, path: file };
    return { error: `저장하지 못했습니다 (${e.code || e.message}).` };
  }
  log('saved export', file);
  return { ok: true, path: file };
}
/** native folder picker (Windows); resolves to the chosen folder or null */
function pickFolder(initial) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  // the initial folder goes through the environment, never into the script text
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '저장할 폴더를 선택하세요'",
    '$d.ShowNewFolderButton = $true',
    'if ($env:SV_INITIAL -and (Test-Path -LiteralPath $env:SV_INITIAL)) { $d.SelectedPath = $env:SV_INITIAL }',
    '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Width = 1; Height = 1; StartPosition = "CenterScreen" }',
    '$o.Show(); $o.Activate()',
    'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    '$o.Close()',
  ].join('; ');
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, SV_INITIAL: initial || '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.once('error', () => resolve(null));
    child.once('exit', () => resolve(out.trim() || null));
  });
}

// ---- files passed on the command line / forwarded from other instances ----
const STEP_EXT = /\.(step|stp|iges|igs|brep|brp|sldprt|sldasm|x_t|xmt_txt)$/i;
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
  return { id, name: path.basename(p), size, mtime, dir: path.dirname(p) };
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

// A window that is closed sends /api/bye (pagehide beacon) -> exit shortly after the last one is gone.
// A connection that merely dropped (window asleep/frozen by the browser, system sleep) gets a long grace
// period instead: the window keeps working and reconnects when it wakes up.
// The decision is made for the connection that went away last (each window has its own id).
const byeCids = new Map(); // window id -> time of its goodbye
let lastGoneCid = null;
const CLOSE_GRACE_MS = 8000, DROP_GRACE_MS = 30 * 60 * 1000;
function scheduleExitCheck() {
  clearTimeout(exitTimer);
  if (clients.size > 0) return;
  const closed = lastGoneCid !== null && byeCids.has(lastGoneCid);
  exitTimer = setTimeout(() => {
    if (clients.size === 0 && everConnected) {
      log(closed ? 'no viewer windows left, exiting' : 'viewer connection lost for a long time, exiting');
      process.exit(0);
    }
  }, closed ? CLOSE_GRACE_MS : DROP_GRACE_MS);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => { total += c.length; if (total > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
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
      if (p === '/api/hello') return json(res, 200, { app: APP_ID, pid: process.pid, version: getVersion() });

      // update endpoints: the custom header makes cross-site requests need a CORS preflight (which we never grant)
      // saving exported files (DXF) where the user chose; the custom header keeps other sites out (CORS preflight)
      if (p.startsWith('/api/save/')) {
        if (req.headers['x-stepviewer'] !== '1') return json(res, 403, { error: 'forbidden' });
        if (p === '/api/save/defaults' && req.method === 'GET') return json(res, 200, { dir: defaultSaveDir() });
        if (p === '/api/save/pick-folder' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req) || '{}');
          return json(res, 200, { path: await pickFolder(typeof body.initial === 'string' ? body.initial : '') });
        }
        if (p === '/api/save/file' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 64e6) || '{}');
          const r = saveExport(body);
          return json(res, r.error && !r.exists ? 400 : 200, r); // "already exists" is an answer, not a failure
        }
        return json(res, 404, { error: 'not found' });
      }

      if (p.startsWith('/api/update/')) {
        if (req.headers['x-stepviewer'] !== '1') return json(res, 403, { error: 'forbidden' });
        if (p === '/api/update/check' && req.method === 'GET') {
          const current = getVersion();
          try {
            const rel = await latestRelease();
            const newer = compareVersions(rel.version, current) > 0;
            return json(res, 200, { current, latest: rel.version, newer, url: rel.url, notes: rel.notes, published: rel.published,
              canUpdate: newer && !!rel.asset && !!updateTarget(),
              reason: !newer ? null : !rel.asset ? '릴리즈에 StepViewer.exe 파일이 없습니다.' : !updateTarget() ? '개발 모드에서는 자동 업데이트를 할 수 없습니다.' : null });
          } catch (e) {
            return json(res, 200, { current, latest: null, newer: false, canUpdate: false, url: RELEASES_PAGE, error: `최신 버전을 확인하지 못했습니다: ${e.message || e}` });
          }
        }
        if (p === '/api/update/start' && req.method === 'POST') {
          if (!['downloading', 'checking', 'verifying', 'restarting'].includes(upd.phase)) runUpdate();
          return json(res, 202, { ok: true });
        }
        if (p === '/api/update/cancel' && req.method === 'POST') {
          if (upd.phase === 'downloading' && updAbort) updAbort.abort(new Error('cancelled'));
          return json(res, 200, { ok: true, phase: upd.phase });
        }
        if (p === '/api/update/status' && req.method === 'GET') return json(res, 200, { ...upd, current: getVersion() });
        return json(res, 404, { error: 'not found' });
      }

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
        const cid = url.searchParams.get('cid') || '';
        req.on('close', () => { clearInterval(ka); clients.delete(res); lastGoneCid = cid; scheduleExitCheck(); });
        return;
      }

      if (p === '/api/bye' && req.method === 'POST') {
        const now = Date.now();
        for (const [k, t] of byeCids) if (now - t > 60000) byeCids.delete(k);
        byeCids.set(url.searchParams.get('cid') || '', now);
        res.writeHead(204); res.end();
        scheduleExitCheck();
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

function cleanupAfterUpdate() {
  const exe = updateTarget();
  if (!exe) return;
  let tries = 0;
  const tick = () => {
    let left = 0;
    for (const f of [exe + '.old', exe + '.download']) {
      if (!fs.existsSync(f)) continue;
      try { fs.unlinkSync(f); } catch { left++; }
    }
    if (left && ++tries < 20) setTimeout(tick, 1000);
  };
  tick();
}

async function main() {
  // run by the updater of the previous version to make sure this exe starts and is the expected version
  const chk = process.argv.find((a) => a.startsWith('--sv-check-version='));
  if (chk) process.exit(chk.slice(chk.indexOf('=') + 1) === getVersion() ? 0 : 3);
  // started by an update: the previous process must be gone before we take its port / lock
  const after = process.argv.find((a) => a.startsWith('--after-update='));
  const afterUpdate = !!after;
  if (after) {
    const pid = Number(after.split('=')[1]);
    for (let i = 0; i < 100 && pid && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 150));
    log('started after update', getVersion());
  }
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
  cleanupAfterUpdate(); // only now: we are the instance, so no update of ours can be in progress
  serverUrl = `http://127.0.0.1:${actualPort}/`;
  log('StepViewer listening on', serverUrl, sea ? '(packaged)' : '(dev)', getVersion());
  if (afterUpdate) {
    // the windows of the previous version reconnect by themselves (and reload); open one only if none does
    setTimeout(() => { if (clients.size === 0) openBrowser(appUrl(serverUrl)); }, 8000);
  } else openBrowser(appUrl(serverUrl));

  // If no window ever connects (browser failed to open), don't linger forever.
  setTimeout(() => {
    if (!everConnected && process.env.STEPVIEWER_KEEPALIVE !== '1') { log('no client connected in 120s, exiting'); process.exit(0); }
  }, 120000);
}

process.on('uncaughtException', (e) => log('uncaught', e && e.stack));
main();
