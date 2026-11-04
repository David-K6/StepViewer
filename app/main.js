import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/CSS2DRenderer.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d);
const DEFAULT_COLOR = [0.72, 0.75, 0.8];
// Highlights tint the part's own color: an added emissive alone does nothing on white/very bright parts.
const SEL_TINT = new THREE.Color(0x2f7bff), SEL_EMISSIVE = new THREE.Color(0x0a1f4a);
const HOVER_TINT = new THREE.Color(0x9cc6ff);
const BLACK = new THREE.Color(0);

// ---------------------------------------------------------------- renderer
const canvas = $('canvas');
const viewportEl = $('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: true });
renderer.localClippingEnabled = true;
renderer.autoClear = false;
renderer.info.autoReset = false;
renderer.setClearColor(0x000000, 0);
const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(basePixelRatio);
const labelRenderer = new CSS2DRenderer({ element: $('labels') });

const U = { sectionColor: new THREE.Color(0xe8743b) };

function makePartMaterial(rgb, vertexColors) {
  return new THREE.MeshPhongMaterial({
    color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace),
    vertexColors, shininess: 38, specular: 0x202020, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

// ---------------------------------------------------------------- parser pool
// Workers hold a WASM heap that never shrinks, so a worker is discarded after a big file
// and idle workers are released after a short timeout.
const BIG_FILE = 8e6, WORKER_IDLE_MS = 30000;
// The worker script, its imports and the OCCT WASM are prefetched once as blobs: workers are created
// lazily (and discarded after big files), and a later worker must still start when the local server
// is no longer reachable (e.g. it exited while the window was asleep).
let workerUrl = 'worker.js';
const workerAssetsReady = (async () => {
  if (location.protocol === 'file:') return;
  try {
    const blobUrl = async (u, type) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${u}: ${r.status}`);
      return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
    };
    const [occt, sw, wasm, wk] = await Promise.all([
      blobUrl('vendor/occt-import-js.js', 'text/javascript'), blobUrl('swfile.js', 'text/javascript'),
      blobUrl('vendor/occt-import-js.wasm', 'application/wasm'), blobUrl('worker.js', 'text/javascript')]);
    const boot = `self.__svAssets=${JSON.stringify({ occt, sw, wasm })};importScripts(${JSON.stringify(wk)});`;
    workerUrl = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
  } catch (e) { console.warn('[StepViewer] worker prefetch failed, using the server copy', e); }
})();
class ParserPool {
  constructor(max) { this.max = max; this.idle = []; this.all = []; this.queue = []; this.seq = 0; }
  /** @param resolveFile (fileName) => Promise<ArrayBuffer|null>, used by assemblies for non-embedded references */
  parse(name, buffer, quality, resolveFile = null, extra = {}, owner = null) {
    return new Promise((resolve, reject) => { this.queue.push({ name, buffer, quality, resolveFile, extra, owner, resolve, reject }); this.pump(); });
  }
  /** abandon the jobs of a closed tab: queued ones are dropped, a running one takes its worker down with it
   *  (it may be blocked waiting for a referenced file or deep inside OCCT) */
  cancel(owner) {
    for (const job of this.queue.filter((j) => j.owner === owner)) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(new Error('cancelled'));
    }
    for (const w of this.all.slice()) {
      const job = w._job;
      if (!job || job.owner !== owner) continue;
      w._job = null;
      this.kill(w);
      job.reject(new Error('cancelled'));
    }
    this.pump();
  }
  kill(w) {
    clearTimeout(w._idleTimer);
    w.terminate();
    this.all = this.all.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
  }
  pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.all.length < this.max) { w = new Worker(workerUrl); this.all.push(w); }
      if (!w) return;
      clearTimeout(w._idleTimer);
      const job = this.queue.shift();
      const id = ++this.seq;
      const bytes = job.buffer.byteLength; // read before transfer detaches the buffer
      w._job = job;
      w.onmessage = (ev) => {
        if (w._job !== job) return; // cancelled
        if (ev.data.need) { // worker asks for a referenced file
          const reply = (buf) => { if (w._job === job) w.postMessage({ needReply: ev.data.rid, buffer: buf || null }, buf ? [buf] : []); };
          Promise.resolve(job.resolveFile ? job.resolveFile(ev.data.need) : null).then(reply, () => reply(null));
          return;
        }
        w._job = null;
        if (bytes > BIG_FILE) this.kill(w);
        else {
          this.idle.push(w);
          w._idleTimer = setTimeout(() => this.kill(w), WORKER_IDLE_MS);
        }
        if (ev.data.ok) job.resolve(ev.data); else job.reject(new Error(ev.data.error));
        this.pump();
      };
      w.onerror = (e) => {
        if (w._job !== job) return;
        w._job = null;
        this.kill(w);
        job.reject(new Error(e.message || '해석 작업자(워커)가 중단되었습니다. 메모리가 부족했을 수 있습니다.'));
        this.pump();
      };
      w.postMessage({ id, name: job.name, buffer: job.buffer, quality: job.quality, ...job.extra }, [job.buffer]);
    }
  }
  get workerCount() { return this.all.length; }
}
const pool = new ParserPool(Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1)));

// ---------------------------------------------------------------- state
const tabs = [];
let active = null;
let tabSeq = 0;
let mode = 'select';
let needsRender = true;
const requestRender = () => { needsRender = true; };

const controls = new OrbitControls(new THREE.PerspectiveCamera(), canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.25;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.rotateSpeed = 0.9;
controls.zoomSpeed = 1.4;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.enabled = false;
controls.addEventListener('change', requestRender);

// Free orbit without the pole limit: OrbitControls clamps the polar angle to [0, π] around camera.up.
// Instead, drags rotate about the screen's vertical / horizontal axes and camera.up turns along, so the
// model can be turned over freely. Damping is kept by applying the accumulated rotation gradually.
const freeRot = { left: 0, up: 0 };
controls._rotateLeft = (a) => { freeRot.left += a; };
controls._rotateUp = (a) => { freeRot.up += a; };
const _Y = new THREE.Vector3(0, 1, 0), _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion();
const _fUp = new THREE.Vector3(), _fRight = new THREE.Vector3(), _fOff = new THREE.Vector3();
function syncControlsUp() {
  controls._quat.setFromUnitVectors(controls.object.up, _Y);
  controls._quatInverse.copy(controls._quat).invert();
}
function applyFreeRotation(k) {
  const l = freeRot.left * k, u = freeRot.up * k;
  freeRot.left -= l; freeRot.up -= u;
  if (Math.abs(freeRot.left) < 1e-5) freeRot.left = 0;
  if (Math.abs(freeRot.up) < 1e-5) freeRot.up = 0;
  if (Math.abs(l) < 1e-9 && Math.abs(u) < 1e-9) return false;
  const cam = controls.object;
  cam.updateMatrixWorld();
  _fUp.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
  _fRight.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  _fq.setFromAxisAngle(_fUp, -l); // horizontal drag: about the screen's vertical axis
  _fRight.applyQuaternion(_fq);
  _fq2.setFromAxisAngle(_fRight, -u); // vertical drag: about the screen's horizontal axis
  _fq.premultiply(_fq2);
  _fOff.subVectors(cam.position, controls.target).applyQuaternion(_fq);
  cam.position.copy(controls.target).add(_fOff);
  cam.up.copy(_fUp).applyQuaternion(_fq);
  cam.lookAt(controls.target);
  syncControlsUp();
  return true;
}
const orbitUpdate = controls.update.bind(controls);
controls.update = (dt) => {
  syncControlsUp(); // camera.up may have been changed by views / projection switches
  const rotated = applyFreeRotation(controls.enableDamping ? controls.dampingFactor : 1);
  return orbitUpdate(dt) || rotated;
};

// ---------------------------------------------------------------- tabs
function createTab(name) {
  const tab = {
    id: ++tabSeq, name, loading: true, parts: [], nodes: [], rootNode: null,
    scene: new THREE.Scene(), overlay: new THREE.Scene(), model: new THREE.Group(),
    box: new THREE.Box3(), diag: 1, triCount: 0,
    persp: new THREE.PerspectiveCamera(40, 1, 0.1, 1000),
    ortho: new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000),
    isOrtho: false, target: new THREE.Vector3(),
    selection: new Set(), hover: null, globalOpacity: 1, showEdges: true,
    edgeObjs: [], edgeDirty: true,
    clipPlanes: [], section: null, sectionPlaneObjs: new THREE.Group(), caps: [],
    measures: [], pending: null, expanded: new Set(), loadInfo: '',
  };
  tab.camera = tab.persp;
  tab.scene.add(tab.model);
  tab.scene.add(new THREE.HemisphereLight(0xffffff, 0x444a55, 1.6));
  const head = new THREE.DirectionalLight(0xffffff, 1.6);
  head.position.set(0.3, 0.6, 1);
  tab.persp.add(head);
  const head2 = head.clone();
  tab.ortho.add(head2);
  tab.scene.add(tab.persp, tab.ortho);
  tab.overlay.add(tab.sectionPlaneObjs);
  tab.measureGroup = new THREE.Group();
  tab.overlay.add(tab.measureGroup);
  tabs.push(tab);
  renderTabs();
  return tab;
}

function renderTabs() {
  const el = $('tabs');
  el.innerHTML = '';
  for (const t of tabs) {
    const d = document.createElement('div');
    d.className = 'tab' + (t === active ? ' active' : '');
    d.title = t.name + (t.loadInfo ? '\n' + t.loadInfo : '');
    if (t.loading) d.appendChild(Object.assign(document.createElement('span'), { className: 'mini-spin' }));
    d.appendChild(Object.assign(document.createElement('span'), { className: 'name', textContent: t.name }));
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: '닫기 (Ctrl+W)' });
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    d.appendChild(x);
    d.onclick = () => activateTab(t);
    d.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    el.appendChild(d);
    if (t === active) requestAnimationFrame(() => d.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  $('empty').classList.toggle('hidden', tabs.length > 0);
}

function activateTab(tab) {
  if (active === tab) return;
  closeContextMenu();
  if (camAnim) { camAnim.step(Infinity); camAnim = null; }
  if (active) {
    cancelPending();
    active.overlay.traverse((o) => { if (o.isCSS2DObject) o.element.style.display = 'none'; });
  }
  active = tab;
  if (tab) {
    controls.object = tab.camera;
    controls.target = tab.target;
    controls.enabled = !tab.loading;
    syncCameraAspect(tab);
    controls.update();
    snapObj.removeFromParent();
    tab.overlay.add(snapObj);
  } else controls.enabled = false;
  renderTabs();
  renderTree();
  updateProps();
  syncToolbar();
  syncSectionUI();
  renderMeasureList();
  updateStatus();
  $('loading').classList.toggle('hidden', !(tab && tab.loading));
  if (tab && tab.loading) $('loadingText').textContent = `${tab.name} 해석 중…`;
  requestRender();
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.closed = true;
  tabs.splice(i, 1);
  if (tab.loading) pool.cancel(tab);
  for (const p of tab.parts) {
    p.mesh.geometry.disposeBoundsTree?.();
    p.mesh.geometry.dispose();
    p.material.dispose();
  }
  for (const e of tab.edgeObjs) { e.geometry.dispose(); e.material.dispose(); }
  for (const m of tab.measures) disposeMeasure(m);
  if (tab.pending) { disposeMeasure(tab.pending); tab.pending = null; }
  disposeSectionObjs(tab);
  tab.scene.clear(); tab.overlay.clear();
  if (active === tab) { active = null; activateTab(tabs[Math.min(i, tabs.length - 1)] || null); }
  else renderTabs();
  if (!tabs.length) { renderTree(); updateStatus(); }
}

// ---------------------------------------------------------------- loading
const CAD_EXT = /\.(step|stp|iges|igs|brep|brp|sldprt|sldasm)$/i;
const isAsm = (n) => /\.sldasm$/i.test(n);

/** SolidWorks keeps original reference names ("rear container.SLDPRT") while Pack and Go adds
 *  suffixes ("rear container_261022.SLDPRT"): exact name first, then "<stem>[_ -]*.<same ext>". */
function matchRefName(names, want) {
  const w = want.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === w);
  if (exact) return exact;
  const dot = w.lastIndexOf('.');
  const ext = w.slice(dot), stem = w.slice(0, dot);
  return names.filter((n) => {
    const l = n.toLowerCase();
    return l.endsWith(ext) && l.length > w.length && l.startsWith(stem) && '_ -'.includes(l[stem.length]);
  }).sort((a, b) => a.length - b.length)[0] || null;
}

async function openFiles(fileList) {
  const files = [...fileList];
  for (const f of files) if (!CAD_EXT.test(f.name)) toast(`지원하지 않는 형식: ${f.name}`, true);
  const cad = files.filter((f) => CAD_EXT.test(f.name));
  // dropping an assembly together with its part files: the other files only serve as references
  const asms = cad.filter((f) => isAsm(f.name));
  const open = asms.length ? asms : cad;
  const refs = asms.length ? cad.filter((f) => !isAsm(f.name)) : [];
  if (refs.length) toast(`조립품과 함께 놓은 파일 ${refs.length}개는 조립품 참조용으로만 사용합니다.`);
  const byName = new Map(cad.map((f) => [f.name, f]));
  const resolveFile = async (want) => {
    const hit = matchRefName([...byName.keys()], want);
    return hit ? byName.get(hit).arrayBuffer() : null;
  };
  for (const f of open) loadBuffer(f.name, () => f.arrayBuffer(), f.size, resolveFile);
}

// ---- parsed-model cache (IndexedDB): reopening the same file skips the expensive OCCT step
const CACHE_MAX = 12;
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res) => {
    try {
      const r = indexedDB.open('stepviewer-cache', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('parsed'); r.result.createObjectStore('meta'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return dbP;
}
async function cacheGet(key) {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const tx = d.transaction(['parsed', 'meta'], 'readwrite');
      const g = tx.objectStore('parsed').get(key);
      g.onsuccess = () => { if (g.result) tx.objectStore('meta').put(Date.now(), key); res(g.result || null); };
      g.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function cachePut(key, data) {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(['parsed', 'meta'], 'readwrite');
    tx.objectStore('parsed').put(data, key);
    tx.objectStore('meta').put(Date.now(), key);
    const meta = tx.objectStore('meta');
    const keysReq = meta.getAllKeys();
    const valsReq = meta.getAll();
    valsReq.onsuccess = () => {
      const items = keysReq.result.map((k, i) => [k, valsReq.result[i]]).sort((a, b) => b[1] - a[1]);
      for (const [k] of items.slice(CACHE_MAX)) { tx.objectStore('parsed').delete(k); meta.delete(k); }
    };
  } catch (e) { console.warn('cache put failed', e); }
}

/** a cached result must be structurally sound with finite coordinates (never trust stored data blindly) */
function cachedGeometryOk(r) {
  if (!r || !Array.isArray(r.meshes) || !r.meshes.length || !r.tree) return false;
  for (const m of r.meshes) {
    if (!m || !m.position || !m.index || m.position.length % 3) return false;
    const p = m.position;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
    const nv = p.length / 3, I = m.index;
    for (let i = 0; i < I.length; i++) if (I[i] >= nv) return false;
  }
  return true;
}

async function contentHash(buffer) {
  try {
    if (!crypto.subtle) return null;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function loadBuffer(name, getBuffer, size, resolveFile = null) {
  const tab = createTab(name);
  activateTab(tab);
  const t0 = performance.now();
  const timer = setInterval(() => {
    if (active === tab) $('loadingText').textContent = `${name} 해석 중… ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 200);
  try {
    const quality = $('quality').value;
    const buffer = await getBuffer();
    if (!size) size = buffer.byteLength;
    // cache key = file content hash (not name/mtime), so different files can never collide
    const hash = await contentHash(buffer);
    const popt = window.__svParseOpts && Object.keys(window.__svParseOpts).length ? '|' + JSON.stringify(window.__svParseOpts) : '';
    // v3: entries written by older versions (no corrupted-face filtering, cached partial assemblies) are ignored
    // sw2: SolidWorks results now carry the files' appearance colors
    const fmtVer = /\.sld(prt|asm)$/i.test(name) ? 'sw2|' : '';
    const cacheKey = hash ? `v3|${fmtVer}${quality}${popt}|${buffer.byteLength}|${hash}` : null;
    let result = cacheKey ? await cacheGet(cacheKey) : null;
    // results depending on other files must never come from the cache (older versions could store them)
    if (result && ((result.missing && result.missing.length) || (result.usedSiblings && result.usedSiblings.length) || !cachedGeometryOk(result))) result = null;
    const fromCache = !!result;
    if (tab.closed) return;
    if (!result) {
      result = await pool.parse(name, buffer, quality, resolveFile, window.__svParseOpts || {}, tab);
      // results that depend on other files (used or missing ones) change when those files do -> never cache them
      if (cacheKey && !tab.closed && !(result.usedSiblings && result.usedSiblings.length) && !(result.missing && result.missing.length)) cachePut(cacheKey, result);
    }
    if (tab.closed) return;
    const tParsed = performance.now();
    buildModel(tab, result);
    const tBuilt = performance.now();
    tab.loadInfo = `크기 ${(size / 1048576).toFixed(2)} MB · ${fromCache ? '캐시' : '해석'} ${((tParsed - t0) / 1000).toFixed(2)}s · 생성 ${((tBuilt - tParsed) / 1000).toFixed(2)}s`;
    tab.loadTimeMs = tBuilt - t0;
    tab.loading = false;
    console.info(`[StepViewer] ${name}: ${tab.loadInfo}`, result.timing);
    tab.missing = result.missing || [];
    const warn = [];
    if (tab.missing.length) {
      const list = tab.missing.slice(0, 4).join(', ') + (tab.missing.length > 4 ? ` 외 ${tab.missing.length - 4}개` : '');
      warn.push(`표시 데이터가 없는 부품 ${tab.missing.length}개를 건너뛰었습니다 (${list}). 부품(또는 원본 STEP) 파일을 같은 폴더에 두고 열거나, 조립품과 함께 끌어다 놓으세요.`);
    }
    if (result.invalidFaces) warn.push(`손상된 표시 데이터 면 ${result.invalidFaces}개를 건너뛰었습니다. 파일이 손상되었을 수 있습니다.`);
    if (warn.length) toast(`${name}: ${warn.join(' / ')}`, true);
    if (active === tab) {
      controls.enabled = true;
      $('loading').classList.add('hidden');
      renderTree(); updateStatus(); syncSectionUI(); updateProps();
    }
    renderTabs();
    scheduleBvhBuild(tab);
    requestRender();
  } catch (e) {
    if (tab.closed) return; // closed while loading (job cancelled)
    console.error(e);
    toast(`${name}: ${e.message}`, true);
    closeTab(tab);
  } finally {
    clearInterval(timer);
  }
}


function buildModel(tab, result) {
  const parts = [];
  result.meshes.forEach((m, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal && m.normal.length === m.position.length) geo.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    geo.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (m.colors) {
      geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3, true));
    }
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const rgb = m.color || DEFAULT_COLOR;
    const mat = makePartMaterial(m.colors ? [1, 1, 1] : rgb, !!m.colors);
    mat.clippingPlanes = tab.clipPlanes;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.visible = !m.hidden;
    const part = {
      id: i, name: m.name || '', mesh, material: mat, baseColor: mat.color.clone(), rgb, hasVertexColors: !!m.colors,
      visible: !m.hidden, opacity: 1, edges: m.edges, faceFirst: m.faceFirst, faceLast: m.faceLast,
      triCount: m.index.length / 3, box: geo.boundingBox.clone(), node: null, adj: null,
    };
    mesh.userData.part = part;
    tab.triCount += part.triCount;
    tab.model.add(mesh);
    parts.push(part);
  });
  tab.parts = parts;

  // tree
  const nodes = [];
  const mk = (name, parent, part = null) => {
    const n = { id: nodes.length, name, parent, children: [], part, partList: [], depth: parent ? parent.depth + 1 : 0 };
    nodes.push(n);
    if (parent) parent.children.push(n);
    return n;
  };
  const walk = (src, parent) => {
    const kids = src.children || [];
    const meshes = src.meshes || [];
    if (parent && kids.length === 0 && meshes.length === 1) {
      const p = parts[meshes[0]];
      const n = mk(src.name || p.name || `Part ${meshes[0] + 1}`, parent, p);
      p.node = n;
      if (!p.name) p.name = n.name;
      return n;
    }
    const n = mk(src.name || (parent ? 'Assembly' : tab.name), parent);
    for (const c of kids) walk(c, n);
    for (const mi of meshes) {
      const p = parts[mi];
      const leaf = mk(p.name || src.name || `Body ${mi + 1}`, n, p);
      p.node = leaf;
      if (!p.name) p.name = leaf.name;
    }
    return n;
  };
  const root = walk(result.tree, null);
  if (!root.name) root.name = tab.name;
  // partList (descendant parts) bottom-up
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.part) n.partList.push(n.part);
    if (n.parent) for (const p of n.partList) n.parent.partList.push(p);
  }
  // parts without a node (should not happen) -> attach to root
  for (const p of parts) if (!p.node) { p.node = mk(p.name || `Part ${p.id + 1}`, root, p); root.partList.push(p); }
  tab.nodes = nodes;
  tab.rootNode = root;
  tab.expanded.add(root.id);
  let n = root;
  while (n.children.length === 1 && !n.children[0].part) { n = n.children[0]; tab.expanded.add(n.id); }

  tab.box.makeEmpty();
  for (const p of parts) tab.box.union(p.box);
  if (tab.box.isEmpty()) tab.box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  tab.diag = tab.box.getSize(new THREE.Vector3()).length() || 1;
  tab.model.updateMatrixWorld(true);
  updateGhostState(tab);
  initSection(tab);
  tab.edgeDirty = true;
  setView(tab, 'iso', false);
}

// Build BVHs during idle time so picking/hover never stalls later.
function scheduleBvhBuild(tab) {
  const queue = tab.parts.slice().sort((a, b) => b.triCount - a.triCount);
  const step = (deadline) => {
    if (tab.closed) return;
    const t0 = performance.now();
    while (queue.length && (deadline ? deadline.timeRemaining() > 2 : performance.now() - t0 < 8)) {
      const p = queue.pop();
      ensureBvh(p);
    }
    if (queue.length) (window.requestIdleCallback || setTimeout)(step, { timeout: 500 });
  };
  (window.requestIdleCallback || setTimeout)(step, { timeout: 500 });
}
function ensureBvh(p) {
  const g = p.mesh.geometry;
  if (!g.boundsTree) g.computeBoundsTree({ indirect: true, targetLeafSize: 12 });
}

// ---------------------------------------------------------------- materials / visibility
let colorEditing = false;
function effOpacity(tab, p) { return p.opacity * tab.globalOpacity; }
function applyPart(tab, p) {
  const o = effOpacity(tab, p);
  const m = p.material;
  m.opacity = o;
  m.transparent = o < 0.999;
  m.depthWrite = !m.transparent;
  p.mesh.visible = p.visible && o > 0.004;
  // while the color picker is open, show selected parts in their true color (no highlight tint)
  const sel = tab.selection.has(p) && !colorEditing;
  m.color.copy(p.baseColor);
  if (sel) m.color.lerp(SEL_TINT, 0.5);
  else if (tab.hover === p && !tab.selection.has(p)) m.color.lerp(HOVER_TINT, 0.25);
  m.emissive.copy(sel ? SEL_EMISSIVE : BLACK);
}
function refreshParts(tab, list = tab.parts) {
  for (const p of list) applyPart(tab, p);
  updateGhostState(tab);
  if (tab.caps.length) applySection(tab);
  tab.edgeDirty = true;
  requestRender();
}

function rebuildEdges(tab) {
  for (const e of tab.edgeObjs) { e.removeFromParent(); e.geometry.dispose(); e.material.dispose(); }
  tab.edgeObjs = [];
  tab.edgeDirty = false;
  if (!tab.showEdges) return;
  // one merged draw call per opacity bin (bin 10 = opaque)
  const groups = Array.from({ length: 11 }, () => []);
  for (const p of tab.parts) {
    if (!p.mesh.visible || !p.edges.length) continue;
    const o = effOpacity(tab, p);
    groups[o >= 0.999 ? 10 : Math.min(9, Math.round(o * 10))].push(p);
  }
  groups.forEach((list, gi) => {
    if (!list.length) return;
    let total = 0;
    for (const p of list) total += p.edges.length;
    const arr = new Float32Array(total);
    let o = 0;
    for (const p of list) { arr.set(p.edges, o); o += p.edges.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x14171c, clippingPlanes: tab.clipPlanes });
    if (gi < 10) { mat.transparent = true; mat.opacity = Math.max(0.06, (gi / 10) * 0.6); mat.depthWrite = false; }
    const ls = new THREE.LineSegments(g, mat);
    ls.matrixAutoUpdate = false;
    ls.frustumCulled = false;
    ls.raycast = () => {};
    tab.scene.add(ls);
    tab.edgeObjs.push(ls);
  });
}

// ---------------------------------------------------------------- camera / views
function viewSize() { return { w: viewportEl.clientWidth || 1, h: viewportEl.clientHeight || 1 }; }
function syncCameraAspect(tab) {
  const { w, h } = viewSize();
  const a = w / h;
  tab.persp.aspect = a;
  tab.persp.updateProjectionMatrix();
  const half = tab.diag;
  tab.ortho.left = -half * a; tab.ortho.right = half * a; tab.ortho.top = half; tab.ortho.bottom = -half;
  tab.ortho.updateProjectionMatrix();
}

function updateClipRange(tab) {
  const cam = tab.camera;
  const d = cam.position.distanceTo(tab.target);
  const toCenter = cam.position.distanceTo(tab.box.getCenter(_v1));
  if (cam.isPerspectiveCamera) {
    cam.near = Math.max(d * 0.01, tab.diag * 1e-6, (toCenter - tab.diag) * 0.9, 1e-4);
    cam.near = Math.min(cam.near, Math.max(d * 0.5, 1e-4));
    cam.far = toCenter + tab.diag * 1.5 + d;
  } else {
    cam.near = -(toCenter + tab.diag * 2);
    cam.far = toCenter + tab.diag * 2;
  }
  cam.updateProjectionMatrix();
}

const VIEWS = {
  iso: [1, -1, 0.8], front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
  top: [0, -1e-4, 1], bottom: [0, 1e-4, -1],
};
let camAnim = null;

function fitParams(tab, box, dir) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, tab.diag * 1e-4);
  const cam = tab.camera;
  if (cam.isPerspectiveCamera) {
    const fov = THREE.MathUtils.degToRad(cam.fov);
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * cam.aspect));
    const dist = (r / Math.sin(fit / 2)) * 1.05;
    return { target: sphere.center, pos: sphere.center.clone().addScaledVector(dir, dist), zoom: cam.zoom };
  }
  const half = Math.min(cam.top, cam.right);
  return { target: sphere.center, pos: sphere.center.clone().addScaledVector(dir, tab.diag * 2), zoom: half / (r * 1.08) };
}

/** toUp: camera up at the end (named views bring Z back up after free rotation); null keeps it */
function animateCamera(tab, toPos, toTarget, toZoom, ms = 280, toUp = null) {
  const cam = tab.camera;
  freeRot.left = freeRot.up = 0;
  if (cam.position.distanceToSquared(tab.target) < 1e-20) ms = 0; // degenerate start (fresh camera)
  if (ms <= 0) {
    camAnim = null;
    if (toUp) cam.up.copy(toUp);
    tab.target.copy(toTarget);
    cam.position.copy(toPos);
    cam.zoom = toZoom;
    cam.updateProjectionMatrix();
    cam.lookAt(tab.target);
    requestRender();
    return;
  }
  const fromPos = cam.position.clone(), fromTarget = tab.target.clone(), fromZoom = cam.zoom, fromUp = cam.up.clone();
  const qUp = toUp ? new THREE.Quaternion().setFromUnitVectors(fromUp, toUp) : null;
  const fromOff = fromPos.clone().sub(fromTarget), toOff = toPos.clone().sub(toTarget);
  const fromDist = fromOff.length(), toDist = toOff.length();
  const q = new THREE.Quaternion().setFromUnitVectors(fromOff.normalize(), toOff.normalize());
  const qi = new THREE.Quaternion();
  const t0 = performance.now();
  camAnim = { tab, step(now) { const t = Math.min(1, (now - t0) / ms); apply(t); return t < 1; } };
  function apply(t) {
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const dir = fromOff.clone().applyQuaternion(qi.identity().slerp(q, e));
    tab.target.lerpVectors(fromTarget, toTarget, e);
    cam.position.copy(tab.target).addScaledVector(dir, fromDist + (toDist - fromDist) * e);
    cam.zoom = fromZoom + (toZoom - fromZoom) * e;
    cam.updateProjectionMatrix();
    if (qUp) cam.up.copy(fromUp).applyQuaternion(new THREE.Quaternion().slerp(qUp, e)).normalize();
    cam.lookAt(tab.target);
    requestRender();
  }
}

function visibleBox(tab, list) {
  const b = new THREE.Box3();
  for (const p of list) if (p.mesh.visible) b.union(p.box);
  if (b.isEmpty()) b.copy(tab.box);
  return b;
}

function setView(tab, name, animate = true) {
  if (!tab) return;
  const cam = tab.camera;
  const dir = name === 'fit'
    ? cam.position.clone().sub(tab.target).normalize()
    : new THREE.Vector3(...VIEWS[name]).normalize();
  const sel = name === 'fit' && tab.selection.size ? [...tab.selection] : tab.parts;
  const f = fitParams(tab, visibleBox(tab, sel), dir);
  syncCameraAspect(tab);
  animateCamera(tab, f.pos, f.target, f.zoom, animate ? 300 : 0, name === 'fit' ? null : Z_UP);
}
const Z_UP = new THREE.Vector3(0, 0, 1);

function fitSelection() {
  if (!active) return;
  setView(active, 'fit');
}

function toggleProjection() {
  const tab = active;
  if (!tab || tab.loading) return;
  const from = tab.camera;
  const off = from.position.clone().sub(tab.target);
  const dir = off.clone().normalize();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(tab.persp.fov) / 2);
  syncCameraAspect(tab);
  if (!tab.isOrtho) {
    const d = off.length();
    tab.ortho.zoom = tab.ortho.top / (d * tanHalf);
    tab.ortho.position.copy(tab.target).addScaledVector(dir, tab.diag * 2);
    tab.camera = tab.ortho;
  } else {
    const halfH = tab.ortho.top / tab.ortho.zoom;
    tab.persp.position.copy(tab.target).addScaledVector(dir, halfH / tanHalf);
    tab.camera = tab.persp;
  }
  tab.isOrtho = !tab.isOrtho;
  tab.camera.up.copy(from.up);
  tab.camera.lookAt(tab.target);
  tab.camera.updateProjectionMatrix();
  controls.object = tab.camera;
  controls.update();
  syncToolbar();
  requestRender();
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function setRayFromEvent(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, active.camera);
}

function pick(ev) {
  const tab = active;
  if (!tab || tab.loading) return null;
  setRayFromEvent(ev);
  const cands = [];
  const ray = raycaster.ray;
  for (const p of tab.parts) {
    if (!capVisiblePart(tab, p)) continue;
    const s = p.mesh.geometry.boundingSphere;
    if (!ray.intersectsSphere(s)) continue;
    ensureBvh(p);
    cands.push(p.mesh);
  }
  raycaster.firstHitOnly = tab.clipPlanes.length === 0;
  const hits = raycaster.intersectObjects(cands, false);
  const eps = tab.diag * 1e-7;
  const clipped = (pt, except) => tab.clipPlanes.some((pl) => pl !== except && pl.distanceToPoint(pt) < -eps);
  // nearest real (unclipped) surface
  let surf = null;
  for (const h of hits) {
    if (clipped(h.point)) continue;
    const normal = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 0, 1);
    if (normal.dot(ray.direction) > 0) normal.negate();
    surf = { point: h.point.clone(), normal, part: h.object.userData.part, tri: h.faceIndex, distance: h.distance };
    break;
  }
  // nearest section cap in front of it: a point on a cut plane is filled when it lies inside a solid,
  // i.e. the ray crosses that part's surface an odd number of times beyond the point (parity test)
  if (tab.caps.length) {
    let cap = null;
    for (const pl of tab.clipPlanes) {
      const pt = ray.intersectPlane(pl, new THREE.Vector3());
      if (!pt) continue;
      const t = pt.distanceTo(ray.origin);
      if ((surf && t >= surf.distance) || (cap && t >= cap.distance) || clipped(pt, pl)) continue;
      // is this point of the cut plane inside a (cap-visible) solid?
      let owner = null;
      for (const p of tab.parts) {
        if (capVisiblePart(tab, p) && pointInPart(p, pt, eps)) { owner = p; break; }
      }
      if (!owner) continue;
      const n = pl.normal.clone();
      if (n.dot(ray.direction) > 0) n.negate();
      cap = { point: pt, normal: n, part: owner, tri: -1, distance: t, cap: true };
    }
    if (cap) return cap;
  }
  return surf;
}
// Robust point-in-solid test: crossing parity along 3 fixed, "irrational" directions, majority vote.
// Rays from the query point (instead of the camera ray) avoid degenerate grazing of edges/vertices.
const IN_DIRS = [new THREE.Vector3(0.5773, 0.5774, 0.5775), new THREE.Vector3(-0.8017, 0.2673, 0.5345), new THREE.Vector3(0.1543, -0.9258, 0.3442)].map((v) => v.normalize());
const inRay = new THREE.Raycaster();
function pointInPart(p, pt, eps) {
  if (!p.box.clone().expandByScalar(eps * 10).containsPoint(pt)) return false;
  ensureBvh(p);
  inRay.firstHitOnly = false;
  let votes = 0;
  for (const d of IN_DIRS) {
    inRay.set(pt, d);
    const hits = inRay.intersectObject(p.mesh, false);
    let n = 0, lastD = -Infinity;
    for (const h of hits) { if (h.distance - lastD > eps * 10) n++; lastD = h.distance; }
    if (n % 2 === 1) votes++;
  }
  return votes >= 2;
}

// parts that contribute to section caps (same rule as picking: ghosted parts are excluded)
// Strongly transparent ("ghosted") parts are click-through and get no caps,
// unless everything visible is that transparent (then everything counts).
const GHOST = 0.3;
function updateGhostState(tab) { tab.allGhost = tab.parts.every((p) => !p.mesh.visible || effOpacity(tab, p) < GHOST); }
function capVisiblePart(tab, p) { return p.mesh.visible && (tab.allGhost || effOpacity(tab, p) >= GHOST); }

function worldPerPixel(tab, point) {
  const cam = tab.camera;
  const { h } = viewSize();
  if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
  const depth = _v1.copy(point).sub(cam.position).dot(cam.getWorldDirection(_v2));
  return (2 * Math.max(depth, 1e-6) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / h;
}

// Snap to CAD vertices (segment endpoints) or edges of the hit part near the cursor.
function snapHit(hit, ev) {
  if (!hit) return null;
  hit.snap = 'face';
  if (hit.cap) { hit.snap = 'cap'; return hit; }
  if (!$('snapOn').checked || ev.shiftKey) return hit;
  const tab = active;
  const eps = tab.diag * 1e-7;
  const kept = (v) => !tab.clipPlanes.some((pl) => pl.distanceToPoint(v) < -eps);
  const wpp = worldPerPixel(tab, hit.point);
  const tolEdge = wpp * 8, tolVert = wpp * 11;
  const e = hit.part.edges;
  const ray = raycaster.ray;
  const a = _v1, b = _v2, onSeg = new THREE.Vector3(), onRay = new THREE.Vector3();
  let best = null, bestD = Infinity, bestV = null, bestVD = Infinity, bestSeg = -1;
  const reach2 = (tolVert * 3) ** 2;
  const hp = hit.point;
  for (let i = 0; i < e.length; i += 6) {
    a.set(e[i], e[i + 1], e[i + 2]); b.set(e[i + 3], e[i + 4], e[i + 5]);
    // quick reject: segment far from hit point
    const d2 = distSqPointSeg(hp, a, b);
    if (d2 > reach2) continue;
    const dr = Math.sqrt(ray.distanceSqToSegment(a, b, onRay, onSeg));
    if (dr < tolEdge && dr < bestD && kept(onSeg)) { bestD = dr; best = onSeg.clone(); bestSeg = i / 6; }
    for (const v of [a, b]) {
      const dv = ray.distanceSqToPoint(v);
      if (dv < tolVert * tolVert && dv < bestVD && v.distanceToSquared(hp) < reach2 && kept(v)) { bestVD = dv; bestV = v.clone(); bestSeg = i / 6; }
    }
  }
  if (bestV) { hit.point.copy(bestV); hit.snap = 'vertex'; hit.seg = bestSeg; }
  else if (best) { hit.point.copy(best); hit.snap = 'edge'; hit.seg = bestSeg; }
  return hit;
}
function distSqPointSeg(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? (apx * abx + apy * aby + apz * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

// Walk the polyline of a CAD edge (through degree-2 vertices) starting at segment s.
function edgeChain(tab, part, s) {
  const e = part.edges;
  const q = 1 / (tab.diag * 1e-6);
  const key = (i) => `${Math.round(e[i] * q)},${Math.round(e[i + 1] * q)},${Math.round(e[i + 2] * q)}`;
  if (!part.adj) {
    const adj = new Map();
    for (let i = 0; i < e.length; i += 6) {
      for (const off of [0, 3]) {
        const k = key(i + off);
        let l = adj.get(k); if (!l) adj.set(k, (l = []));
        l.push(i / 6);
      }
    }
    part.adj = adj;
  }
  const adj = part.adj;
  const pt = (seg, end) => new THREE.Vector3(e[seg * 6 + end * 3], e[seg * 6 + end * 3 + 1], e[seg * 6 + end * 3 + 2]);
  const used = new Set([s]);
  const walk = (seg, end) => {
    const out = [];
    let cur = seg, curEnd = end;
    for (let guard = 0; guard < 5000; guard++) {
      const k = key(cur * 6 + curEnd * 3);
      const l = adj.get(k);
      if (!l || l.length !== 2) break;
      const nxt = l[0] === cur ? l[1] : l[0];
      if (used.has(nxt)) { out.closed = true; break; }
      used.add(nxt);
      const nk0 = key(nxt * 6);
      const nEnd = nk0 === k ? 1 : 0;
      out.push(pt(nxt, nEnd));
      cur = nxt; curEnd = nEnd;
    }
    return out;
  };
  const fwd = walk(s, 1);
  const back = walk(s, 0);
  const pts = [...back.reverse(), pt(s, 0), pt(s, 1), ...fwd];
  return { pts, closed: !!fwd.closed || !!back.closed };
}

function circleFrom3(a, b, c) {
  const ab = _v1.copy(b).sub(a), ac = _v2.copy(c).sub(a);
  const n = new THREE.Vector3().crossVectors(ab, ac);
  const n2 = n.lengthSq();
  if (n2 < 1e-20) return null;
  const t1 = new THREE.Vector3().crossVectors(n, ab).multiplyScalar(ac.lengthSq());
  const t2 = new THREE.Vector3().crossVectors(ac, n).multiplyScalar(ab.lengthSq());
  const center = a.clone().add(t1.add(t2).divideScalar(2 * n2));
  return { center, radius: center.distanceTo(a), normal: n.normalize() };
}

function fitCircleChain(pts) {
  if (pts.length < 4) return null;
  const n = pts.length;
  const c = circleFrom3(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)]);
  if (!c) return null;
  const tol = Math.max(c.radius * 0.01, 1e-6);
  for (const p of pts) {
    if (Math.abs(p.distanceTo(c.center) - c.radius) > tol) return null;
    if (Math.abs(_v3.copy(p).sub(c.center).dot(c.normal)) > tol) return null;
  }
  return c;
}

/** eigen decomposition of a symmetric 3x3 matrix (Jacobi), eigenvalues ascending */
function eigSym3(A) {
  const a = A.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    if (a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2 < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - sn * y; a[k][q] = sn * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - sn * y; a[q][k] = sn * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - sn * y; V[k][q] = sn * x + c * y; }
    }
  }
  const ids = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: ids.map((i) => a[i][i]), vectors: ids.map((i) => new THREE.Vector3(V[0][i], V[1][i], V[2][i]).normalize()) };
}

/** The clicked B-rep face as a cylinder (full, half or partial): axis = the direction all vertex normals are
 *  perpendicular to, radius/center = circle fit of the vertices projected along it. null if not a cylinder. */
function fitCylinderFace(tab, hit) {
  const part = hit.part;
  const f = brepFaceOf(part, hit.tri);
  if (f < 0) return null;
  const g = part.mesh.geometry;
  const pos = g.getAttribute('position').array, nrmA = g.getAttribute('normal'), idx = g.getIndex().array;
  if (!nrmA) return null;
  const nrm = nrmA.array;
  const seen = new Set(), P = [], N = [];
  for (let t = part.faceFirst[f]; t <= part.faceLast[f]; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      if (seen.has(v)) continue;
      seen.add(v);
      const n = new THREE.Vector3().fromArray(nrm, v * 3);
      if (n.lengthSq() < 1e-12) continue;
      P.push(new THREE.Vector3().fromArray(pos, v * 3)); N.push(n.normalize());
    }
  }
  if (P.length < 6) return null;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const n of N) { const a = [n.x, n.y, n.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += a[i] * a[j]; }
  const { values, vectors } = eigSym3(M);
  const cnt = N.length;
  if (values[1] / cnt < 0.003) return null; // normals do not turn: plane (or a sliver of an arc)
  if (values[0] / cnt > 0.002) return null; // normals are not all perpendicular to one axis: cone, sphere, torus...
  const axis = vectors[0];
  const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const w = new THREE.Vector3().crossVectors(axis, u);
  const c0 = new THREE.Vector3();
  for (const p of P) c0.add(p);
  c0.divideScalar(P.length);
  // algebraic circle fit (Kasa) in the plane perpendicular to the axis
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  const XY = P.map((p) => { const d = _v1.copy(p).sub(c0); return [d.dot(u), d.dot(w)]; });
  for (const [x, y] of XY) { const z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z; }
  const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, XY.length]], rhs = [-sxz, -syz, -sz];
  const det3 = (q) => q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const D0 = det3(m);
  if (!Number.isFinite(D0) || Math.abs(D0) < 1e-300) return null;
  const sol = [0, 1, 2].map((c) => det3(m.map((row, r) => row.map((x, k) => (k === c ? rhs[r] : x)))) / D0);
  const cx = -sol[0] / 2, cy = -sol[1] / 2, r = Math.sqrt(cx * cx + cy * cy - sol[2]);
  if (!Number.isFinite(r) || r <= 0 || r > tab.diag * 10) return null;
  const tol = Math.max(r * 0.005, tab.diag * 1e-6);
  let a0 = Infinity, a1 = -Infinity;
  // radius as a linear function of the axial position: a cone (even a very flat one) has a slope
  let sh = 0, shh = 0, sr = 0, shr = 0;
  for (let i = 0; i < P.length; i++) {
    const [x, y] = XY[i];
    const rad = Math.hypot(x - cx, y - cy);
    if (Math.abs(rad - r) > tol) return null;
    // normals of a cylinder are radial and exactly perpendicular to the axis (0.17°)
    if (Math.abs(N[i].dot(axis)) > 0.003) return null;
    const radial = _v2.copy(u).multiplyScalar((x - cx) / rad).addScaledVector(w, (y - cy) / rad);
    if (Math.abs(radial.dot(N[i])) < 0.95) return null;
    const h = _v1.copy(P[i]).sub(c0).dot(axis);
    a0 = Math.min(a0, h); a1 = Math.max(a1, h);
    sh += h; shh += h * h; sr += rad; shr += h * rad;
  }
  const varH = shh / P.length - (sh / P.length) ** 2;
  if (varH > 1e-12) {
    const slope = (shr / P.length - (sh / P.length) * (sr / P.length)) / varH;
    if (Math.abs(slope) > 0.002) return null; // radius changes along the axis -> cone
  }
  const base = c0.clone().addScaledVector(u, cx).addScaledVector(w, cy);
  const center = base.clone().addScaledVector(axis, _v1.copy(hit.point).sub(c0).dot(axis));
  return { center, radius: r, normal: axis, p0: base.clone().addScaledVector(axis, a0), p1: base.clone().addScaledVector(axis, a1), length: a1 - a0 };
}

function brepFaceOf(part, tri) {
  const f = part.faceFirst, l = part.faceLast;
  let lo = 0, hi = f.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tri < f[mid]) hi = mid - 1;
    else if (tri > l[mid]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ---------------------------------------------------------------- measurement
const MCOLOR = 0xffd166;
const lineMat = new THREE.LineBasicMaterial({ color: MCOLOR, depthTest: false, transparent: true });
const dashMat = new THREE.LineDashedMaterial({ color: MCOLOR, depthTest: false, transparent: true, dashSize: 1, gapSize: 1 });
const ptMat = new THREE.PointsMaterial({ color: MCOLOR, size: 7, sizeAttenuation: false, depthTest: false, transparent: true });

function mkLabel(text, cls = 'mlabel') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return new CSS2DObject(d);
}
function mkLine(points, loop = false) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const l = loop ? new THREE.LineLoop(g, lineMat) : new THREE.Line(g, lineMat);
  l.renderOrder = 999;
  l.raycast = () => {};
  return l;
}
function mkPoints(points) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const p = new THREE.Points(g, ptMat);
  p.renderOrder = 1000;
  p.raycast = () => {};
  return p;
}

const snapDot = document.createElement('div');
snapDot.className = 'snapdot';
const snapObj = new CSS2DObject(snapDot);
snapObj.visible = false;

const HINTS = {
  distance: '두 점을 클릭하세요. 꼭짓점(분홍)·모서리(파랑)에 자동 스냅 — Shift를 누르면 스냅 해제. 두 면이 평행하면 면간 거리도 표시합니다.',
  angle: '세 점을 클릭: 시작점 → 각의 꼭짓점 → 끝점. (두 평면 사이 각도는 면 위 아무 점이나 찍어도 면 법선으로 함께 계산)',
  radius: '원/호 모서리나 원통(반원통) 면을 클릭하면 반경·지름·중심을 측정합니다. 그 밖의 곳은 원주 위 3점을 클릭하세요.',
  face: '면을 클릭하면 면적, 법선(평면인 경우), 중심을 표시합니다.',
  pickplane: '단면 기준이 될 면을 클릭하세요. (Esc 취소)',
};

function setMode(m) {
  cancelPending();
  mode = m;
  document.querySelectorAll('#toolbar [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  const measuring = m !== 'select';
  viewportEl.classList.toggle('mode-measure', measuring);
  $('measurePanel').classList.toggle('hidden', !(measuring && m !== 'pickplane') && !(active && active.measures.length));
  $('measureHint').textContent = HINTS[m] || (active && active.measures.length ? '측정 도구를 선택하세요.' : '');
  if (!measuring) { snapObj.visible = false; }
  requestRender();
}

function cancelPending() {
  const tab = active;
  if (tab && tab.pending) {
    disposeMeasure(tab.pending);
    tab.pending = null;
  }
  snapObj.visible = false;
  requestRender();
}

function addPendingPoint(hit) {
  const tab = active;
  if (!tab.pending) {
    const group = new THREE.Group();
    tab.measureGroup.add(group);
    tab.pending = { type: mode, pts: [], normals: [], group, rubber: null, label: null };
  }
  const pd = tab.pending;
  pd.pts.push(hit.point.clone());
  pd.normals.push(hit.snap === 'face' || hit.snap === 'edge' || hit.snap === 'vertex' ? hit.normal.clone() : null);
  rebuildPending(null);
  const need = mode === 'distance' ? 2 : 3;
  if (pd.pts.length >= need) finishPending();
}

function rebuildPending(hover) {
  const pd = active && active.pending;
  if (!pd) return;
  for (const c of [...pd.group.children]) { if (c.isCSS2DObject) c.element.remove(); c.geometry?.dispose(); pd.group.remove(c); }
  const pts = hover ? [...pd.pts, hover] : pd.pts;
  pd.group.add(mkPoints(pd.pts));
  if (pts.length >= 2) {
    pd.group.add(mkLine(pts));
    if (hover && pd.type === 'distance') {
      const l = mkLabel(`${fmt(pts[0].distanceTo(pts[1]))} mm`, 'mlabel temp');
      l.position.copy(pts[0]).add(pts[1]).multiplyScalar(0.5);
      pd.group.add(l);
    }
    if (hover && pd.type === 'angle' && pts.length === 3) {
      const l = mkLabel(`${fmt(angleAt(pts[0], pts[1], pts[2]), 2)}°`, 'mlabel temp');
      l.position.copy(pts[1]);
      pd.group.add(l);
    }
  }
  requestRender();
}

function angleAt(a, v, b) {
  const u = a.clone().sub(v), w = b.clone().sub(v);
  return THREE.MathUtils.radToDeg(u.angleTo(w));
}

function finishPending() {
  const tab = active;
  const pd = tab.pending;
  tab.pending = null;
  pd.group.removeFromParent();
  pd.group.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); o.geometry?.dispose(); });
  const [a, b, c] = pd.pts;
  if (pd.type === 'distance') {
    const d = b.clone().sub(a);
    const lines = [`<b>거리 ${fmt(d.length())} mm</b>`, `ΔX ${fmt(d.x)}  ΔY ${fmt(d.y)}  ΔZ ${fmt(d.z)}`];
    let label = `${fmt(d.length())} mm`;
    const [n1, n2] = pd.normals;
    if (n1 && n2 && Math.abs(n1.dot(n2)) > 0.9998) {
      const perp = Math.abs(d.dot(n1));
      if (perp < 1e-6) lines.push('두 점이 같은 평면 위에 있음');
      else {
        lines.push(`평행면 수직거리 ${fmt(perp)} mm`);
        if (Math.abs(perp - d.length()) > 1e-6) label += ` (⊥ ${fmt(perp)})`;
      }
    }
    addMeasure(tab, 'distance', lines, label, a.clone().add(b).multiplyScalar(0.5), [mkLine([a, b]), mkPoints([a, b])]);
  } else if (pd.type === 'angle') {
    const ang = angleAt(a, b, c);
    const lines = [`<b>각도 ${fmt(ang, 3)}°</b>`, `보각 ${fmt(180 - ang, 3)}°`];
    addMeasure(tab, 'angle', lines, `${fmt(ang, 2)}°`, b, [mkLine([a, b, c]), mkPoints([a, b, c]), arcObj(a, b, c)]);
  } else if (pd.type === 'radius') {
    const circ = circleFrom3(a, b, c);
    if (!circ) { toast('세 점이 일직선상에 있습니다.', true); return; }
    addCircleMeasure(tab, circ, a, '3점');
  }
}

function arcObj(a, v, b) {
  const u = a.clone().sub(v), w = b.clone().sub(v);
  const r = Math.min(u.length(), w.length()) * 0.3;
  const ang = u.angleTo(w);
  const n = new THREE.Vector3().crossVectors(u, w).normalize();
  const pts = [];
  const un = u.clone().normalize();
  for (let i = 0; i <= 24; i++) pts.push(v.clone().addScaledVector(un.clone().applyAxisAngle(n, (ang * i) / 24), r));
  return mkLine(pts);
}

function addCircleMeasure(tab, circ, onPt, how, extraLines = [], extraObjs = []) {
  const { center, radius, normal } = circ;
  const pts = [];
  const u = onPt.clone().sub(center).normalize();
  for (let i = 0; i < 64; i++) pts.push(center.clone().addScaledVector(u.clone().applyAxisAngle(normal, (i / 64) * Math.PI * 2), radius));
  const lines = [`<b>Ø ${fmt(radius * 2)} mm</b>  R ${fmt(radius)} mm`,
    `중심 (${fmt(center.x)}, ${fmt(center.y)}, ${fmt(center.z)})`,
    `축 (${fmt(normal.x, 4)}, ${fmt(normal.y, 4)}, ${fmt(normal.z, 4)}) · ${how}`, ...extraLines];
  const rim = onPt.clone().sub(center);
  rim.addScaledVector(normal, -rim.dot(normal));
  const onCircle = rim.lengthSq() > 1e-18 ? center.clone().addScaledVector(rim.normalize(), radius) : onPt;
  addMeasure(tab, 'radius', lines, `Ø${fmt(radius * 2)} R${fmt(radius)}`, center,
    [mkLine(pts, true), mkLine([center, onCircle]), mkPoints([center, onCircle]), ...extraObjs]);
}

function faceMeasure(tab, hit) {
  const part = hit.part;
  const f = brepFaceOf(part, hit.tri);
  const g = part.mesh.geometry;
  const pos = g.getAttribute('position').array, idx = g.getIndex().array;
  const first = f >= 0 ? part.faceFirst[f] : hit.tri, last = f >= 0 ? part.faceLast[f] : hit.tri;
  let area = 0;
  const cen = new THREE.Vector3(), n0 = new THREE.Vector3(), tmp = new THREE.Vector3();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let planar = true;
  const tri = new Float32Array((last - first + 1) * 9);
  let o = 0;
  for (let t = first; t <= last; t++) {
    A.fromArray(pos, idx[t * 3] * 3); B.fromArray(pos, idx[t * 3 + 1] * 3); C.fromArray(pos, idx[t * 3 + 2] * 3);
    tmp.crossVectors(_v1.copy(B).sub(A), _v2.copy(C).sub(A));
    const ar = tmp.length() / 2;
    if (ar > 0) {
      tmp.normalize();
      if (n0.lengthSq() === 0) n0.copy(tmp);
      else if (Math.abs(tmp.dot(n0)) < 0.99995) planar = false;
    }
    area += ar;
    cen.addScaledVector(_v3.copy(A).add(B).add(C).divideScalar(3), ar);
    for (const P of [A, B, C]) { tri[o++] = P.x; tri[o++] = P.y; tri[o++] = P.z; }
  }
  if (area > 0) cen.divideScalar(area);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.BufferAttribute(tri, 3));
  const hm = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: MCOLOR, transparent: true, opacity: 0.45, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: tab.clipPlanes }));
  hm.raycast = () => {};
  const lines = [`<b>면적 ${fmt(area)} mm²</b>`, `부품: ${escapeHtml(part.name)} · 면 #${f + 1}${tab.clipPlanes.length ? ' (단면과 무관한 원래 면 전체)' : ''}`];
  if (planar) {
    if (n0.dot(hit.normal) < 0) n0.negate();
    lines.push(`평면 · 법선 (${fmt(n0.x, 4)}, ${fmt(n0.y, 4)}, ${fmt(n0.z, 4)})`);
  } else lines.push('곡면');
  lines.push(`중심 (${fmt(cen.x)}, ${fmt(cen.y)}, ${fmt(cen.z)})`);
  addMeasure(tab, 'face', lines, `${fmt(area, 2)} mm²`, hit.point, [hm]);
}

function addMeasure(tab, type, lines, labelText, labelPos, objs) {
  const group = new THREE.Group();
  for (const o of objs) group.add(o);
  const lbl = mkLabel(labelText);
  lbl.position.copy(labelPos);
  group.add(lbl);
  tab.measureGroup.add(group);
  const m = { type, lines, group, label: lbl };
  tab.measures.push(m);
  renderMeasureList();
  requestRender();
  return m;
}
function disposeMeasure(m) {
  m.group.removeFromParent();
  m.group.traverse((o) => {
    if (o.isCSS2DObject) o.element.remove();
    o.geometry?.dispose();
    if (o.material && o.material !== lineMat && o.material !== ptMat && o.material !== dashMat) o.material.dispose();
  });
}
function removeMeasure(tab, m) {
  disposeMeasure(m);
  tab.measures = tab.measures.filter((x) => x !== m);
  renderMeasureList();
  requestRender();
}
function renderMeasureList() {
  const el = $('measureList');
  el.innerHTML = '';
  const tab = active;
  const list = tab ? tab.measures : [];
  const ICON = { distance: '↔', angle: '∠', radius: '◯', face: '▱' };
  list.forEach((m, i) => {
    const d = document.createElement('div');
    d.className = 'mitem';
    d.innerHTML = `<span>${ICON[m.type]}${i + 1}</span><div class="mv">${m.lines.join('<br>')}</div>`;
    const x = Object.assign(document.createElement('button'), { textContent: '✕', title: '삭제' });
    x.onclick = () => removeMeasure(tab, m);
    d.appendChild(x);
    d.onmouseenter = () => { m.label.element.style.background = '#ffd16655'; };
    d.onmouseleave = () => { m.label.element.style.background = ''; };
    el.appendChild(d);
  });
  el.scrollTop = el.scrollHeight;
  $('measurePanel').classList.toggle('hidden', !(mode !== 'select' && mode !== 'pickplane') && !list.length);
  if (mode === 'select') $('measureHint').textContent = list.length ? '측정 도구를 선택하세요.' : '';
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------- section
function initSection(tab) {
  const b = tab.box;
  tab.section = {
    x: { on: false, pos: (b.min.x + b.max.x) / 2, flip: false },
    y: { on: false, pos: (b.min.y + b.max.y) / 2, flip: false },
    z: { on: false, pos: (b.min.z + b.max.z) / 2, flip: false },
    c: { on: false, pos: 0, flip: false, normal: null, origin: null, min: 0, max: 1 },
    caps: true, showPlanes: true,
  };
}
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
function axisRange(tab, ax) {
  if (ax === 'c') return [tab.section.c.min, tab.section.c.max];
  const pad = tab.diag * 0.005;
  return [tab.box.min[ax] - pad, tab.box.max[ax] + pad];
}

// remove the half that faces the camera so the cut face is visible
function autoFlip(tab, ax) {
  return tab.camera.position[ax] < tab.box.getCenter(new THREE.Vector3())[ax];
}

function sectionContour(tab, plane, parts) {
  const out = [];
  const n = plane.normal, c = plane.constant;
  for (const p of parts) {
    const g = p.mesh.geometry;
    const pos = g.getAttribute('position').array, idx = g.getIndex().array;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, e = idx[t + 2] * 3;
      const da = n.x * pos[a] + n.y * pos[a + 1] + n.z * pos[a + 2] + c;
      const db = n.x * pos[b] + n.y * pos[b + 1] + n.z * pos[b + 2] + c;
      const de = n.x * pos[e] + n.y * pos[e + 1] + n.z * pos[e + 2] + c;
      if ((da > 0 && db > 0 && de > 0) || (da < 0 && db < 0 && de < 0)) continue;
      let k = 0;
      const pts = [];
      const edge = (i, j, di, dj) => {
        if ((di > 0) === (dj > 0) || di === dj) return;
        const s = di / (di - dj);
        pts.push(pos[i] + (pos[j] - pos[i]) * s, pos[i + 1] + (pos[j + 1] - pos[i + 1]) * s, pos[i + 2] + (pos[j + 2] - pos[i + 2]) * s);
        k++;
      };
      edge(a, b, da, db); edge(b, e, db, de); edge(e, a, de, da);
      if (k === 2) out.push(...pts);
    }
  }
  return new Float32Array(out);
}

function disposeSectionObjs(tab) {
  for (const c of [...tab.sectionPlaneObjs.children]) { c.geometry.dispose(); tab.sectionPlaneObjs.remove(c); }
  for (const cap of tab.caps || []) {
    for (const b of cap.bins) { b.contour.geometry.dispose(); b.contour.material.dispose(); }
    cap.mesh.geometry.dispose();
    cap.backMat.dispose(); cap.frontMat.dispose(); cap.capMat.dispose();
  }
  tab.caps = [];
}

// Real section caps (stencil technique): for each plane, back faces increment and front faces
// decrement the stencil; where the result is non-zero the plane lies inside a solid and is filled.
function makeCap(tab, plane, others) {
  const st = { colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: [plane] };
  const backMat = new THREE.MeshBasicMaterial({ ...st, side: THREE.BackSide,
    stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp });
  const frontMat = new THREE.MeshBasicMaterial({ ...st, side: THREE.FrontSide,
    stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp });
  const capMat = new THREE.MeshBasicMaterial({ color: U.sectionColor, side: THREE.DoubleSide, clippingPlanes: others,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp });
  const center = tab.box.getCenter(new THREE.Vector3());
  const geo = new THREE.PlaneGeometry(tab.diag * 2.2, tab.diag * 2.2);
  const mesh = new THREE.Mesh(geo, capMat);
  plane.projectPoint(center, mesh.position);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
  mesh.updateMatrixWorld(true);
  mesh.matrixAutoUpdate = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  // Parts cut by this plane, grouped by effective opacity: each group gets its own stencil pass and
  // cap with that opacity, so per-part transparency carries over to the cut faces.
  const groups = new Map();
  for (const p of tab.parts) {
    if (!capVisiblePart(tab, p) || !plane.intersectsBox(p.box)) continue;
    const o = Math.round(effOpacity(tab, p) * 20) / 20;
    if (!groups.has(o)) groups.set(o, []);
    groups.get(o).push(p);
  }
  const bins = [...groups].map(([opacity, parts]) => {
    // contour of the parts on this plane -> part boundaries visible on the cap
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sectionContour(tab, plane, parts), 3));
    const contour = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x14171c, clippingPlanes: others,
      transparent: opacity < 0.999, opacity }));
    contour.frustumCulled = false;
    contour.matrixAutoUpdate = false;
    const cs = new THREE.Scene();
    cs.add(contour);
    return { opacity, parts: new Set(parts), contour, scene: cs };
  });
  return { plane, backMat, frontMat, capMat, mesh, scene, bins };
}

function applySection(tab) {
  const s = tab.section;
  tab.clipPlanes.length = 0;
  disposeSectionObjs(tab);
  tab.sectionHandles = [];
  const center = tab.box.getCenter(new THREE.Vector3());
  const size = tab.diag * 0.42;
  for (const ax of ['x', 'y', 'z', 'c']) {
    const st = s[ax];
    if (!st.on) continue;
    const n = ax === 'c' ? st.normal.clone() : AXIS[ax].clone();
    // keep side with n·p <= pos  ->  plane normal = -n, constant = pos
    const plane = new THREE.Plane(n.clone().negate(), st.pos);
    if (st.flip) plane.negate();
    tab.clipPlanes.push(plane);
    if (s.showPlanes) {
      const onPlane = n.clone().multiplyScalar(st.pos).add(_v1.copy(n).multiplyScalar(-n.dot(center))).add(center);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      const geo = new THREE.PlaneGeometry(size * 2, size * 2);
      const fill = new THREE.Mesh(geo, planeFillMat);
      fill.position.copy(onPlane); fill.quaternion.copy(q);
      fill.raycast = () => {};
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), planeEdgeMat);
      edge.position.copy(onPlane); edge.quaternion.copy(q);
      tab.sectionPlaneObjs.add(fill, edge);
      tab.sectionHandles.push({ ax, n, origin: onPlane.clone(), u: new THREE.Vector3(1, 0, 0).applyQuaternion(q), v: new THREE.Vector3(0, 1, 0).applyQuaternion(q), half: size });
    }
  }
  if (s.caps) {
    tab.caps = tab.clipPlanes.map((pl) => makeCap(tab, pl, tab.clipPlanes.filter((o) => o !== pl)));
  }
  tab.edgeDirty = true;
  requestRender();
}
const planeFillMat = new THREE.MeshBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
const planeEdgeMat = new THREE.LineBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.6 });

function syncSectionUI() {
  const tab = active;
  const ok = tab && !tab.loading && tab.section;
  $('btnSection').classList.toggle('active', !$('sectionPanel').classList.contains('hidden'));
  if (!ok) return;
  const s = tab.section;
  document.querySelectorAll('.sec-row').forEach((row) => {
    const ax = row.dataset.axis;
    const st = s[ax];
    const [lo, hi] = axisRange(tab, ax);
    row.querySelector('.sec-on').checked = st.on;
    row.querySelector('.sec-on').disabled = ax === 'c' && !st.normal;
    const r = row.querySelector('.sec-pos');
    r.disabled = ax === 'c' && !st.normal;
    r.value = String(Math.round(((st.pos - lo) / (hi - lo || 1)) * 1000));
    const num = row.querySelector('.sec-num');
    if (num && document.activeElement !== num) num.value = fmt(st.pos, 3);
    row.querySelector('.sec-flip').classList.toggle('on', st.flip);
  });
  $('secCaps').checked = s.caps;
  $('secPlanes').checked = s.showPlanes;
}

document.querySelectorAll('.sec-row').forEach((row) => {
  const ax = row.dataset.axis;
  const st = () => active && active.section && active.section[ax];
  row.querySelector('.sec-on').onchange = (e) => {
    if (!st()) return;
    st().on = e.target.checked;
    if (st().on && ax !== 'c') st().flip = autoFlip(active, ax);
    applySection(active); syncSectionUI();
  };
  row.querySelector('.sec-pos').oninput = (e) => {
    if (!st()) return;
    const [lo, hi] = axisRange(active, ax);
    st().pos = lo + (hi - lo) * (Number(e.target.value) / 1000);
    if (!st().on && ax !== 'c') st().flip = autoFlip(active, ax);
    st().on = true;
    applySection(active); syncSectionUI();
  };
  const num = row.querySelector('.sec-num');
  if (num) num.onchange = (e) => { if (!st()) return; const v = Number(e.target.value); if (Number.isFinite(v)) { st().pos = v; st().on = true; applySection(active); syncSectionUI(); } };
  row.querySelector('.sec-flip').onclick = () => { if (!st()) return; st().flip = !st().flip; applySection(active); syncSectionUI(); };
});
$('btnPickPlane').onclick = () => { if (active && !active.loading) setMode('pickplane'); };
$('secCaps').onchange = (e) => { if (active?.section) { active.section.caps = e.target.checked; applySection(active); } };
$('secPlanes').onchange = (e) => { if (active?.section) { active.section.showPlanes = e.target.checked; applySection(active); } };
$('secColor').oninput = (e) => {
  const c = new THREE.Color(e.target.value);
  U.sectionColor.copy(c);
  requestRender();
};
$('btnSectionReset').onclick = () => { if (active?.section) { initSection(active); applySection(active); syncSectionUI(); } };
function toggleSectionPanel(force) {
  const p = $('sectionPanel');
  const show = force ?? p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  syncSectionUI();
}
$('btnSection').onclick = () => toggleSectionPanel();

/** section plane under the cursor (select mode, section panel open, planes shown) that is not hidden
 *  behind a model surface -> { ax, n, point, t } */
function sectionHandleAt(e, hit) {
  const tab = active;
  if (!tab || tab.loading || mode !== 'select' || !tab.section || !tab.section.showPlanes || !tab.sectionHandles?.length) return null;
  if ($('sectionPanel').classList.contains('hidden')) return null;
  setRayFromEvent(e);
  const ray = raycaster.ray;
  let best = null;
  for (const h of tab.sectionHandles) {
    const pt = ray.intersectPlane(_secPlane.setFromNormalAndCoplanarPoint(h.n, h.origin), new THREE.Vector3());
    if (!pt) continue;
    const d = _v1.copy(pt).sub(h.origin);
    if (Math.abs(d.dot(h.u)) > h.half || Math.abs(d.dot(h.v)) > h.half) continue;
    const t = pt.distanceTo(ray.origin);
    if (hit && hit.distance < t - tab.diag * 1e-4) continue; // a model surface is in front of the plane
    if (!best || t < best.t) best = { ax: h.ax, n: h.n.clone(), point: pt, t };
  }
  return best;
}
const _secPlane = new THREE.Plane();
let planeDrag = null;
function dragSectionTo(e) {
  const d = planeDrag, tab = d.tab;
  if (active !== tab) return;
  setRayFromEvent(e);
  const ray = raycaster.ray;
  const view = tab.camera.getWorldDirection(_v2);
  let s;
  if (Math.abs(view.dot(d.n)) < 0.9) {
    // closest point of the line (grab point + n*s) to the mouse ray
    const w0 = _v1.copy(d.point).sub(ray.origin);
    const b = d.n.dot(ray.direction);
    s = (b * ray.direction.dot(w0) - d.n.dot(w0)) / Math.max(1 - b * b, 1e-9);
  } else {
    // looking (almost) along the normal: vertical mouse motion moves the plane toward / away from the viewer
    s = (d.sy - e.clientY) * worldPerPixel(tab, d.point) * (view.dot(d.n) < 0 ? 1 : -1);
  }
  const [lo, hi] = axisRange(tab, d.ax);
  d.next = Math.min(hi, Math.max(lo, d.startPos + s));
  if (!d.raf) d.raf = requestAnimationFrame(() => {
    d.raf = 0;
    if (active !== d.tab || !d.tab.section) return;
    d.tab.section[d.ax].pos = d.next;
    applySection(d.tab); syncSectionUI();
  });
}
viewportEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target !== canvas || e.shiftKey || e.ctrlKey) return;
  const h = sectionHandleAt(e, pick(e));
  if (!h) return;
  // grab the plane: OrbitControls (listening on the canvas) must not start rotating
  e.stopPropagation();
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  planeDrag = { tab: active, ax: h.ax, n: h.n, point: h.point, sy: e.clientY, startPos: active.section[h.ax].pos, next: null, raf: 0, id: e.pointerId };
  camAnim = null;
}, { capture: true });
function endPlaneDrag(e) {
  if (!planeDrag || (e && e.pointerId !== planeDrag.id)) return false;
  try { canvas.releasePointerCapture(planeDrag.id); } catch { /* already released */ }
  planeDrag = null;
  return true;
}

function pickPlaneFromHit(tab, hit) {
  const n = hit.normal.clone().normalize();
  const s = tab.section.c;
  // projection range of the model box onto n
  let lo = Infinity, hi = -Infinity;
  const b = tab.box;
  for (let i = 0; i < 8; i++) {
    _v1.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
    const d = _v1.dot(n);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  const pad = tab.diag * 0.005;
  Object.assign(s, { on: true, normal: n, min: lo - pad, max: hi + pad, pos: hit.point.dot(n) - tab.diag * 0.002, flip: false });
  applySection(tab);
  toggleSectionPanel(true);
  setMode('select');
}

// ---------------------------------------------------------------- selection / tree
function selectParts(list, additive = false) {
  const tab = active;
  if (!tab) return;
  const changed = new Set(tab.selection);
  if (!additive) tab.selection.clear();
  for (const p of list) {
    if (additive && tab.selection.has(p) && list.length === 1) tab.selection.delete(p);
    else tab.selection.add(p);
  }
  for (const p of tab.selection) changed.add(p);
  for (const p of changed) applyPart(tab, p);
  updateTreeStates();
  updateProps();
  requestRender();
}

function setVisible(tab, list, vis) {
  for (const p of list) p.visible = vis;
  refreshParts(tab, list);
  updateTreeStates();
  updateStatus();
}
function hideSelected() {
  const tab = active;
  if (!tab || !tab.selection.size) return;
  const list = [...tab.selection];
  tab.selection.clear();
  setVisible(tab, list, false);
  updateProps();
}
function isolateSelected() {
  const tab = active;
  if (!tab || !tab.selection.size) return;
  for (const p of tab.parts) p.visible = tab.selection.has(p);
  refreshParts(tab);
  updateTreeStates();
  updateStatus();
  setView(tab, 'fit');
}
function showAll() {
  const tab = active;
  if (!tab) return;
  setVisible(tab, tab.parts, true);
}
/** hide every part that is not selected (camera stays where it is, unlike isolate) */
function hideOthers() {
  const tab = active;
  if (!tab || !tab.selection.size) return;
  setVisible(tab, tab.parts.filter((p) => !tab.selection.has(p) && p.visible), false);
}

// ---- context menu (right click without dragging; right drag still pans)
const ctxMenu = $('ctxMenu');
/** @param onTarget false when right-clicking empty space: hide items act on the clicked target only */
function openContextMenu(x, y, onTarget = true) {
  const tab = active;
  if (!tab || tab.loading) return;
  const sel = onTarget ? tab.selection.size : 0;
  ctxMenu.querySelector('[data-act="hide"]').disabled = !sel;
  ctxMenu.querySelector('[data-act="hideOthers"]').disabled = !sel || tab.parts.every((p) => tab.selection.has(p) || !p.visible);
  ctxMenu.querySelector('[data-act="showAll"]').disabled = tab.parts.every((p) => p.visible);
  ctxMenu.classList.remove('hidden');
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  ctxMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}
function closeContextMenu() { $('ctxMenu').classList.add('hidden'); }
ctxMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  closeContextMenu();
  if (b.dataset.act === 'hide') hideSelected();
  else if (b.dataset.act === 'hideOthers') hideOthers();
  else if (b.dataset.act === 'showAll') showAll();
  requestRender();
});
ctxMenu.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerdown', (e) => { if (!ctxMenu.contains(e.target)) closeContextMenu(); }, true);
window.addEventListener('wheel', closeContextMenu, { passive: true });
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);

let rowByNode = new Map();
function renderTree() {
  const el = $('tree');
  el.innerHTML = '';
  rowByNode = new Map();
  const tab = active;
  if (!tab || tab.loading || !tab.rootNode) return;
  const filter = $('treeFilter').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  const addRow = (n, depth, flat) => {
    const row = document.createElement('div');
    row.className = 'tnode';
    row.dataset.nid = n.id;
    row.style.paddingLeft = `${4 + depth * 14}px`;
    const hasKids = n.children.length > 0 && !flat;
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = hasKids ? (tab.expanded.has(n.id) ? '▾' : '▸') : '';
    const eye = document.createElement('span');
    eye.className = 'eye';
    const sw = document.createElement('span');
    sw.className = 'sw';
    const rgb = n.part ? n.part.rgb : null;
    if (rgb) sw.style.background = `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`;
    else sw.style.visibility = 'hidden';
    const nm = document.createElement('span');
    nm.className = 'tname';
    nm.textContent = n.name;
    nm.title = n.name;
    row.append(tw, eye, sw, nm);
    if (!n.part) {
      const cnt = document.createElement('span');
      cnt.className = 'tcount';
      cnt.textContent = n.partList.length;
      row.appendChild(cnt);
    }
    frag.appendChild(row);
    rowByNode.set(n, row);
    if (hasKids && tab.expanded.has(n.id)) for (const c of n.children) addRow(c, depth + 1, false);
  };
  if (filter) {
    let count = 0;
    for (const n of tab.nodes) {
      if (n.name.toLowerCase().includes(filter)) { addRow(n, 0, true); if (++count > 2000) break; }
    }
  } else addRow(tab.rootNode, 0, false);
  el.appendChild(frag);
  updateTreeStates();
}

function updateTreeStates() {
  const tab = active;
  if (!tab) return;
  for (const [n, row] of rowByNode) {
    let vis = 0, sel = 0;
    for (const p of n.partList) { if (p.visible) vis++; if (tab.selection.has(p)) sel++; }
    const total = n.partList.length;
    row.querySelector('.eye').textContent = vis === 0 ? '○' : vis === total ? '◉' : '◐';
    row.classList.toggle('hiddenpart', vis === 0);
    row.classList.toggle('sel', total > 0 && sel === total);
  }
}

function revealPart(tab, part) {
  let n = part.node && part.node.parent;
  let changed = false;
  while (n) { if (!tab.expanded.has(n.id)) { tab.expanded.add(n.id); changed = true; } n = n.parent; }
  if (changed && !$('treeFilter').value) renderTree();
  const row = rowByNode.get(part.node);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

$('tree').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.tnode');
  const tab = active;
  if (!row || !tab || tab.loading) return;
  if (tab.pending) { cancelPending(); return; } // same as on the model: right click aborts an unfinished measurement
  const n = tab.nodes[Number(row.dataset.nid)];
  if (n.partList.length && !n.partList.every((p) => tab.selection.has(p))) selectParts(n.partList);
  openContextMenu(e.clientX, e.clientY);
});
$('tree').addEventListener('click', (e) => {
  const row = e.target.closest('.tnode');
  const tab = active;
  if (!row || !tab) return;
  const n = tab.nodes[Number(row.dataset.nid)];
  if (e.target.classList.contains('tw')) {
    if (tab.expanded.has(n.id)) tab.expanded.delete(n.id); else tab.expanded.add(n.id);
    renderTree();
    return;
  }
  if (e.target.classList.contains('eye')) {
    const anyVis = n.partList.some((p) => p.visible);
    setVisible(tab, n.partList, !anyVis);
    return;
  }
  selectParts(n.partList, e.ctrlKey || e.metaKey);
});
$('tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tnode');
  if (!row || !active || e.target.classList.contains('eye') || e.target.classList.contains('tw')) return;
  const n = active.nodes[Number(row.dataset.nid)];
  selectParts(n.partList);
  fitSelection();
});
$('treeFilter').addEventListener('input', () => renderTree());
$('btnShowAll').onclick = showAll;
$('btnExpandAll').onclick = () => {
  const tab = active;
  if (!tab || !tab.nodes.length) return;
  const all = tab.nodes.filter((n) => n.children.length).every((n) => tab.expanded.has(n.id));
  if (all) { tab.expanded.clear(); tab.expanded.add(tab.rootNode.id); }
  else for (const n of tab.nodes) if (n.children.length) tab.expanded.add(n.id);
  renderTree();
};

function updateProps() {
  const tab = active;
  const sel = tab ? [...tab.selection] : [];
  $('props').classList.toggle('hidden', !sel.length);
  if (!sel.length) return;
  const b = new THREE.Box3();
  let tris = 0;
  for (const p of sel) { b.union(p.box); tris += p.triCount; }
  const s = b.getSize(new THREE.Vector3());
  $('selName').textContent = sel.length === 1 ? sel[0].name : `${sel.length}개 부품`;
  $('selCount').textContent = '';
  $('selInfo').innerHTML = `크기 X ${fmt(s.x, 2)} × Y ${fmt(s.y, 2)} × Z ${fmt(s.z, 2)} mm<br>` +
    `중심 (${fmt((b.min.x + b.max.x) / 2, 2)}, ${fmt((b.min.y + b.max.y) / 2, 2)}, ${fmt((b.min.z + b.max.z) / 2, 2)})<br>` +
    `삼각형 ${tris.toLocaleString()}`;
  const op = Math.round(sel[0].opacity * 100);
  $('selOpacity').value = op;
  $('selOpacityVal').textContent = op + '%';
  const c = sel[0].baseColor.clone();
  $('selColor').value = '#' + (sel[0].hasVertexColors ? new THREE.Color().setRGB(...DEFAULT_COLOR, THREE.SRGBColorSpace) : c).getHexString();
}
$('selOpacity').oninput = (e) => {
  const tab = active;
  if (!tab) return;
  const v = Number(e.target.value) / 100;
  for (const p of tab.selection) p.opacity = v;
  $('selOpacityVal').textContent = e.target.value + '%';
  refreshParts(tab, [...tab.selection]);
};
$('selColor').oninput = (e) => {
  const tab = active;
  if (!tab) return;
  const c = new THREE.Color(e.target.value);
  for (const p of tab.selection) {
    p.baseColor.copy(c);
    if (p.hasVertexColors) { p.material.vertexColors = false; p.hasVertexColors = false; p.material.needsUpdate = true; }
    const s = c.clone().convertLinearToSRGB();
    p.rgb = [s.r, s.g, s.b];
    applyPart(tab, p);
  }
  renderTree();
  requestRender();
};
function setColorEditing(on) {
  if (colorEditing === on) return;
  colorEditing = on;
  if (!active) return;
  for (const p of active.selection) applyPart(active, p);
  requestRender();
}
// click opens the native picker; change fires when it closes; blur covers cancel + clicking elsewhere
$('selColor').addEventListener('click', () => setColorEditing(true));
$('selColor').addEventListener('change', () => setColorEditing(false));
$('selColor').addEventListener('blur', () => setColorEditing(false));
$('btnHideSel').onclick = hideSelected;
$('btnIsolate').onclick = isolateSelected;
$('btnFitSel').onclick = fitSelection;
$('globalOpacity').oninput = (e) => {
  if (!active) return;
  active.globalOpacity = Number(e.target.value) / 100;
  $('globalOpacityVal').textContent = e.target.value + '%';
  refreshParts(active);
};

// ---------------------------------------------------------------- toolbar / status
function syncToolbar() {
  const tab = active;
  $('btnEdges').classList.toggle('active', !!tab && tab.showEdges);
  const proj = $('btnProj');
  proj.querySelector('small').textContent = tab && tab.isOrtho ? '직교' : '원근';
  proj.firstChild.textContent = tab && tab.isOrtho ? '▭' : '◇';
  const go = tab ? Math.round(tab.globalOpacity * 100) : 100;
  $('globalOpacity').value = go;
  $('globalOpacityVal').textContent = go + '%';
}
document.querySelectorAll('#toolbar [data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
document.querySelectorAll('#toolbar [data-view]').forEach((b) => { b.onclick = () => active && !active.loading && setView(active, b.dataset.view); });
$('btnEdges').onclick = () => { if (!active) return; active.showEdges = !active.showEdges; active.edgeDirty = true; syncToolbar(); requestRender(); };
$('btnProj').onclick = toggleProjection;
function clearMeasures(tab) {
  for (const m of tab.measures) disposeMeasure(m);
  tab.measures = [];
  renderMeasureList();
  requestRender();
}
$('btnClearMeasure').onclick = () => { if (active) clearMeasures(active); };

function updateStatus() {
  const tab = active;
  if (!tab) { $('stFile').textContent = '파일 없음'; $('stStats').textContent = ''; return; }
  $('stFile').textContent = tab.name;
  if (tab.loading) { $('stStats').textContent = '해석 중…'; return; }
  const vis = tab.parts.filter((p) => p.visible).length;
  $('stStats').textContent = `부품 ${vis}/${tab.parts.length} · 삼각형 ${tab.triCount.toLocaleString()} · ${tab.loadInfo}`;
}

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3000);
}

// ---------------------------------------------------------------- pointer interaction
let down = null;
let hoverQueued = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, t: performance.now(), max: 0 }; camAnim = null; });
canvas.addEventListener('pointerup', (e) => {
  if (endPlaneDrag(e)) return;
  if (!down) return;
  const moved = Math.max(down.max, Math.hypot(e.clientX - down.x, e.clientY - down.y)); // a drag that came back is still a drag
  const b = down.b;
  down = null;
  if (moved > 4) return;
  if (b === 2) { onRightClick(e); return; }
  if (b !== 0) return;
  onClick(e);
});
canvas.addEventListener('pointercancel', (e) => { endPlaneDrag(e); });
canvas.addEventListener('pointermove', (e) => {
  if (planeDrag) { if (e.pointerId === planeDrag.id) dragSectionTo(e); return; }
  if (down) down.max = Math.max(down.max, Math.hypot(e.clientX - down.x, e.clientY - down.y));
  if (down && (e.buttons & 7)) { if (active?.hover) { const h = active.hover; active.hover = null; applyPart(active, h); } snapObj.visible = false; return; }
  hoverQueued = e;
});
canvas.addEventListener('pointerleave', () => {
  hoverQueued = null;
  if (active?.hover) { const h = active.hover; active.hover = null; applyPart(active, h); requestRender(); }
  snapObj.visible = false;
  $('stCursor').textContent = '';
});
canvas.addEventListener('dblclick', (e) => {
  const tab = active;
  if (!tab || tab.loading) return;
  const hit = pick(e);
  if (!hit) return;
  const off = tab.camera.position.clone().sub(tab.target);
  animateCamera(tab, hit.point.clone().add(off), hit.point, tab.camera.zoom, 250);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function processHover() {
  const e = hoverQueued;
  hoverQueued = null;
  const tab = active;
  if (!e || !tab || tab.loading || camAnim) return;
  let hit = pick(e);
  if (mode === 'select') {
    const p = hit ? hit.part : null;
    if (tab.hover !== p) {
      const old = tab.hover;
      tab.hover = p;
      if (old) applyPart(tab, old);
      if (p) applyPart(tab, p);
      requestRender();
    }
    canvas.title = p ? p.name : '';
    canvas.style.cursor = sectionHandleAt(e, hit) ? 'move' : '';
  } else {
    if (mode === 'distance' || mode === 'angle' || mode === 'radius') hit = snapHit(hit, e);
    if (hit) {
      snapObj.position.copy(hit.point);
      snapObj.visible = true;
      snapDot.className = 'snapdot ' + (hit.snap || '');
    } else snapObj.visible = false;
    if (tab.pending) rebuildPending(hit ? hit.point : null);
    requestRender();
  }
  $('stCursor').textContent = hit ? `X ${fmt(hit.point.x, 2)}  Y ${fmt(hit.point.y, 2)}  Z ${fmt(hit.point.z, 2)}` : '';
}

/** right click on the model: the part under the cursor becomes the selection unless it already is part of it */
function onRightClick(e) {
  const tab = active;
  if (!tab || tab.loading) return;
  if (tab.pending) { cancelPending(); return; } // right click also aborts an unfinished measurement
  const hit = pick(e);
  if (hit && !tab.selection.has(hit.part)) { selectParts([hit.part]); revealPart(tab, hit.part); }
  openContextMenu(e.clientX, e.clientY, !!hit);
}

function onClick(e) {
  const tab = active;
  if (!tab || tab.loading) return;
  let hit = pick(e);
  if (mode === 'select') {
    if (hit) { selectParts([hit.part], e.ctrlKey || e.metaKey); revealPart(tab, hit.part); }
    else if (!e.ctrlKey) selectParts([]);
    return;
  }
  if (!hit) return;
  if (mode === 'pickplane') { pickPlaneFromHit(tab, hit); return; }
  if (mode === 'face') {
    if (hit.cap) { toast('단면(절단면)은 면 정보 대상이 아닙니다. 모델 표면을 클릭하세요.'); return; }
    faceMeasure(tab, hit);
    return;
  }
  hit = snapHit(hit, e);
  if (mode === 'radius' && !tab.pending && hit.snap === 'edge' || mode === 'radius' && !tab.pending && hit.snap === 'vertex') {
    const chain = edgeChain(tab, hit.part, hit.seg);
    const circ = fitCircleChain(chain.pts);
    if (circ) { addCircleMeasure(tab, circ, hit.point, chain.closed ? '원' : '호'); return; }
  }
  // a click on a cylindrical (or partial cylindrical) face measures that cylinder
  if (mode === 'radius' && !tab.pending && !hit.cap) {
    const cyl = fitCylinderFace(tab, hit);
    if (cyl) {
      addCircleMeasure(tab, cyl, hit.point, '원통면', [`원통 길이 ${fmt(cyl.length)} mm`], [mkLine([cyl.p0, cyl.p1])]);
      return;
    }
  }
  addPendingPoint(hit);
}

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'color' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'o') { e.preventDefault(); $('fileInput').click(); return; }
  if (e.ctrlKey && k === 'w') { e.preventDefault(); if (active) closeTab(active); return; }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length > 1) activateTab(tabs[(tabs.indexOf(active) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
    return;
  }
  if (e.key === '?') { $('help').classList.toggle('hidden'); return; }
  if (e.key === 'Escape') {
    if (!ctxMenu.classList.contains('hidden')) { closeContextMenu(); return; }
    if (!$('help').classList.contains('hidden')) { $('help').classList.add('hidden'); return; }
    if (!$('updateDlg').classList.contains('hidden')) { if (!updBusy) $('updateDlg').classList.add('hidden'); return; }
    if (active?.pending) cancelPending();
    else if (mode !== 'select') setMode('select');
    else selectParts([]);
    return;
  }
  if (!active || active.loading) return;
  if (e.ctrlKey || e.altKey || e.metaKey) {
    if (e.ctrlKey && k === '1') setView(active, 'back');
    else if (e.ctrlKey && k === '3') setView(active, 'left');
    else if (e.ctrlKey && k === '7') setView(active, 'bottom');
    else if (e.ctrlKey && k === 'a') { e.preventDefault(); selectParts(active.parts.filter((p) => p.visible)); }
    return;
  }
  switch (k) {
    case 'f': case 'home': fitSelection(); break;
    case 'h': if (e.shiftKey) showAll(); else hideSelected(); break;
    case 'i': isolateSelected(); break;
    case 's': setMode('select'); break;
    case 'd': setMode('distance'); break;
    case 'a': setMode('angle'); break;
    case 'r': setMode('radius'); break;
    case 'g': setMode('face'); break;
    case 'x': toggleSectionPanel(); break;
    case 'e': $('btnEdges').click(); break;
    case 'o': $('btnOrigin').click(); break;
    case 'p': toggleProjection(); break;
    case '0': setView(active, 'iso'); break;
    case '1': setView(active, 'front'); break;
    case '3': setView(active, 'right'); break;
    case '7': setView(active, 'top'); break;
    case 'c':
      if (!e.shiftKey) return;
      cancelPending();
      clearMeasures(active);
      selectParts([]);
      break;
    case 'delete': case 'backspace':
      if (active.measures.length) removeMeasure(active, active.measures[active.measures.length - 1]);
      break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------- files: button, drag & drop, server push
$('btnOpen').onclick = () => $('fileInput').click();
$('btnOpen2').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { openFiles([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.add('hidden');
  openFiles([...e.dataTransfer.files]);
});
$('btnHelp').onclick = () => $('help').classList.remove('hidden');

// ---------------------------------------------------------------- update check / self update
// The local server asks GitHub for the latest release; the update downloads the new exe, swaps it in and
// restarts. This window then waits for the new server and reloads itself.
const updFetch = (u, o = {}) => fetch(u, { cache: 'no-store', ...o, headers: { 'X-StepViewer': '1', ...(o.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let updBusy = false;
function updMsg(text, err = false) { const m = $('updMsg'); m.textContent = text; m.classList.toggle('err', err); }
async function checkUpdate() {
  if (updBusy) return;
  $('updLatest').textContent = '확인 중…';
  $('btnUpdApply').disabled = true;
  updMsg('');
  try {
    const r = await (await updFetch('/api/update/check')).json();
    $('updCurrent').textContent = r.current || '-';
    if (r.url) $('updLink').href = r.url;
    if (r.error) { $('updLatest').textContent = '-'; updMsg(r.error, true); return; }
    $('updLatest').textContent = r.latest;
    if (!r.newer) updMsg('최신 버전을 사용 중입니다.');
    else if (!r.canUpdate) updMsg(`새 버전 ${r.latest}이(가) 있지만 자동 업데이트할 수 없습니다: ${r.reason || ''} 릴리즈 페이지에서 받아 주세요.`, true);
    else {
      updMsg(`새 버전 ${r.latest}이(가) 있습니다. 업데이트하면 프로그램이 다시 시작되며 열려 있는 파일은 닫힙니다.`);
      $('btnUpdApply').disabled = false;
    }
  } catch (e) {
    $('updLatest').textContent = '-';
    updMsg(`업데이트 정보를 가져오지 못했습니다: ${e.message || e}`, true);
  }
}
async function applyUpdate() {
  if (updBusy) return;
  updBusy = true;
  for (const b of ['btnUpdApply', 'btnUpdCheck']) $(b).disabled = true;
  $('updProgress').classList.remove('hidden');
  $('updBar').style.width = '0%';
  updMsg('새 버전을 받는 중…');
  let oldPid = null;
  try { oldPid = (await (await fetch('/api/hello', { cache: 'no-store' })).json()).pid; } catch { /* ignore */ }
  try {
    await updFetch('/api/update/start', { method: 'POST' });
    let restarting = 0;
    $('btnUpdClose').textContent = '취소';
    $('btnUpdClose').disabled = false;
    for (;;) {
      await sleep(400);
      let st = null;
      try { st = await (await updFetch('/api/update/status')).json(); } catch { st = null; }
      if (!st) { if (restarting) break; continue; } // the old server is gone once it hands over
      if (restarting && Date.now() - restarting > 20000) throw new Error('다시 시작이 끝나지 않았습니다.');
      $('btnUpdClose').disabled = st.phase !== 'downloading';
      if (st.phase === 'downloading' && st.total) {
        $('updBar').style.width = `${Math.min(100, (st.received / st.total) * 100).toFixed(1)}%`;
        updMsg(`새 버전 ${st.version} 받는 중… ${(st.received / 1048576).toFixed(1)} / ${(st.total / 1048576).toFixed(1)} MB`);
      } else if (st.phase === 'verifying') {
        $('updBar').style.width = '100%';
        updMsg(`받은 파일 확인 중…`);
      } else if (st.phase === 'error') {
        updMsg(st.error || '업데이트에 실패했습니다.', true);
        $('updProgress').classList.add('hidden');
        updDone();
        return;
      } else if (st.phase === 'restarting') {
        if (!restarting) restarting = Date.now();
        $('updBar').style.width = '100%';
        updMsg(`${st.version}(으)로 다시 시작하는 중…`);
      }
    }
    // wait for the new version's server, then load its app
    for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
      await sleep(700);
      try {
        const h = await (await fetch('/api/hello', { cache: 'no-store' })).json();
        if (h && h.pid !== oldPid) { location.href = '/'; return; }
      } catch { /* not up yet */ }
    }
    updMsg('새 버전이 시작되지 않았습니다. 이 창을 닫고 StepViewer를 다시 실행해 주세요.', true);
  } catch (e) {
    updMsg(`업데이트에 실패했습니다: ${e.message || e}`, true);
    $('updProgress').classList.add('hidden');
    updDone();
  }
}
function updDone() {
  updBusy = false;
  $('btnUpdCheck').disabled = false;
  $('btnUpdClose').disabled = false;
  $('btnUpdClose').textContent = '닫기';
}
$('btnUpdate').onclick = () => { $('updateDlg').classList.remove('hidden'); checkUpdate(); };
$('btnUpdCheck').onclick = checkUpdate;
$('btnUpdApply').onclick = applyUpdate;
$('btnUpdClose').onclick = () => {
  if (updBusy) { updFetch('/api/update/cancel', { method: 'POST' }).catch(() => {}); return; } // '취소' while downloading
  $('updateDlg').classList.add('hidden');
};
if (location.protocol === 'file:') $('btnUpdate').classList.add('hidden');
$('btnHelpClose').onclick = () => $('help').classList.add('hidden');

function connectServer() {
  if (location.protocol === 'file:') return;
  // the id ties the goodbye beacon to this window's event stream (server: closed vs. merely dropped)
  const cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const es = new EventSource(`/api/events?cid=${cid}`);
  let bootVersion = null;
  es.addEventListener('open', async () => {
    try {
      const h = await (await fetch('/api/hello', { cache: 'no-store' })).json();
      if (bootVersion === null) bootVersion = h.version;
      else if (h.version !== bootVersion) location.href = '/';
    } catch { /* ignore */ }
  });
  es.addEventListener('openfiles', (ev) => {
    for (const f of JSON.parse(ev.data)) {
      loadBuffer(f.name, async () => {
        const r = await fetch(`/api/file/${f.id}`);
        if (!r.ok) throw new Error(`파일을 읽을 수 없습니다 (${r.status})`);
        return r.arrayBuffer();
      }, f.size, async (want) => { // files next to the opened one (assembly references)
        const r = await fetch(`/api/sibling/${f.id}?name=${encodeURIComponent(want)}`);
        return r.status === 200 ? r.arrayBuffer() : null;
      });
    }
  });
  es.addEventListener('focus', () => window.focus());
  window.addEventListener('pagehide', () => { try { navigator.sendBeacon(`/api/bye?cid=${cid}`); } catch { /* ignore */ } });
}
connectServer();

// left panel splitter
$('splitter').addEventListener('pointerdown', (e) => {
  const left = $('left');
  const startX = e.clientX, startW = left.offsetWidth;
  const mv = (ev) => { left.style.width = `${Math.max(180, startW + ev.clientX - startX)}px`; };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- render loop
const triad = document.createElement('canvas');
triad.width = triad.height = 90 * basePixelRatio;
Object.assign(triad.style, { position: 'absolute', left: '8px', bottom: '8px', width: '90px', height: '90px', pointerEvents: 'none' });
viewportEl.appendChild(triad);
const tctx = triad.getContext('2d');
function drawTriad(cam) {
  const s = basePixelRatio;
  tctx.setTransform(s, 0, 0, s, 0, 0);
  tctx.clearRect(0, 0, 90, 90);
  const m = new THREE.Matrix4().extractRotation(cam.matrixWorldInverse);
  const axes = [['X', new THREE.Vector3(1, 0, 0), '#e5534b'], ['Y', new THREE.Vector3(0, 1, 0), '#57ab5a'], ['Z', new THREE.Vector3(0, 0, 1), '#539bf5']]
    .map(([n, v, c]) => [n, v.applyMatrix4(m), c]).sort((a, b) => a[1].z - b[1].z);
  for (const [n, v, c] of axes) {
    const x = 45 + v.x * 30, y = 45 - v.y * 30;
    tctx.strokeStyle = c; tctx.lineWidth = 2.5;
    tctx.beginPath(); tctx.moveTo(45, 45); tctx.lineTo(x, y); tctx.stroke();
    tctx.fillStyle = c; tctx.font = 'bold 12px Segoe UI';
    tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
    // continue along the axis; when the axis points at the viewer (short on screen) blend towards a
    // fixed upper-right offset, so the label never flips sides
    // w * (v / L) equals v / 0.35 below L = 0.35, so the offset is a continuous function of the axis
    const L = Math.hypot(v.x, v.y), w = Math.min(1, L / 0.35);
    const dx = w * (L > 1e-6 ? v.x / L : 0) + (1 - w) * 0.7071, dy = w * (L > 1e-6 ? -v.y / L : 0) - (1 - w) * 0.7071;
    tctx.fillText(n, x + dx * 9, y + dy * 9);
  }
}

const resizeObs = new ResizeObserver(() => {
  const { w, h } = viewSize();
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  if (active) syncCameraAspect(active);
  requestRender();
});
resizeObs.observe(viewportEl);

// performance bookkeeping + adaptive resolution while moving
let frames = 0, fpsT0 = performance.now(), fps = 0, lastRenderMs = 0;
let interacting = false, interactEnd = 0, slowFrames = 0, degraded = false;
controls.addEventListener('start', () => { interacting = true; });
controls.addEventListener('end', () => { interacting = false; interactEnd = performance.now(); });
let lastFrameT = performance.now();

function render(now) {
  const tab = active;
  renderer.info.reset();
  renderer.clear();
  if (!tab || tab.loading) { labelRenderer.render(emptyScene, defaultCam); return; }
  if (tab.edgeDirty) rebuildEdges(tab);
  updateClipRange(tab);
  const moving = interacting || now - interactEnd < 200 || camAnim;
  for (const e of tab.edgeObjs) e.visible = !(degraded && moving);
  const t0 = performance.now();
  renderer.render(tab.scene, tab.camera);
  if (tab.caps.length) {
    const edgeVis = tab.edgeObjs.map((e) => e.visible);
    for (const e of tab.edgeObjs) e.visible = false;
    const saved = tab.parts.map((p) => p.mesh.visible);
    for (const cap of tab.caps) {
      cap.capMat.color.copy(U.sectionColor);
      for (const bin of cap.bins) {
        tab.parts.forEach((p, i) => { p.mesh.visible = saved[i] && bin.parts.has(p); });
        const o = bin.opacity;
        cap.capMat.opacity = o; cap.capMat.transparent = o < 0.999; cap.capMat.depthWrite = o >= 0.999;
        renderer.clearStencil();
        tab.scene.overrideMaterial = cap.backMat;
        renderer.render(tab.scene, tab.camera);
        tab.scene.overrideMaterial = cap.frontMat;
        renderer.render(tab.scene, tab.camera);
        tab.scene.overrideMaterial = null;
        renderer.render(cap.scene, tab.camera);
        renderer.render(bin.scene, tab.camera);
      }
    }
    tab.parts.forEach((p, i) => { p.mesh.visible = saved[i]; });
    tab.edgeObjs.forEach((e, i) => { e.visible = edgeVis[i]; });
  }
  renderer.render(tab.overlay, tab.camera);
  drawOrigin(tab);
  lastRenderMs = performance.now() - t0;
  labelRenderer.render(tab.overlay, tab.camera);
  drawTriad(tab.camera);
  frames++;
}
const emptyScene = new THREE.Scene();
const defaultCam = new THREE.PerspectiveCamera();

// world origin marker: short X/Y/Z arms + a dot, constant size on screen
const originScene = new THREE.Scene();
const originMarker = (() => {
  const g = new THREE.Group();
  const arm = (dir, color) => {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    l.renderOrder = 998;
    return l;
  };
  g.add(arm(new THREE.Vector3(1, 0, 0), 0xe5534b), arm(new THREE.Vector3(0, 1, 0), 0x57ab5a), arm(new THREE.Vector3(0, 0, 1), 0x539bf5));
  const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
    new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }));
  dot.renderOrder = 999;
  g.add(dot);
  g.traverse((o) => { o.raycast = () => {}; o.frustumCulled = false; });
  originScene.add(g);
  return g;
})();
const ORIGIN_PX = 36;
let showOrigin = true;
$('btnOrigin').onclick = () => { showOrigin = !showOrigin; $('btnOrigin').classList.toggle('active', showOrigin); requestRender(); };
function drawOrigin(tab) {
  if (!showOrigin) return;
  originMarker.scale.setScalar(worldPerPixel(tab, originMarker.position) * ORIGIN_PX);
  originMarker.updateMatrixWorld(true);
  renderer.render(originScene, tab.camera);
}

function loop(now) {
  requestAnimationFrame(loop);
  if (hoverQueued && !down) processHover();
  const tab = active;
  if (tab && !tab.loading) {
    if (camAnim && camAnim.tab === tab) { if (!camAnim.step(now)) camAnim = null; needsRender = true; }
    if (controls.enabled && controls.update()) needsRender = true;
  }
  const moving = interacting || now - interactEnd < 200 || !!camAnim;
  if (needsRender) {
    const dt = now - lastFrameT;
    lastFrameT = now;
    // adaptive quality: if frames are slow while moving, drop pixel ratio & hide edges during motion
    if (moving) {
      if (dt > 40 && dt < 500) slowFrames++; else if (dt < 22) slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 4 && !degraded) { degraded = true; if (basePixelRatio > 1) renderer.setPixelRatio(1); }
    } else if (degraded && now - interactEnd > 250) {
      degraded = false; slowFrames = 0;
      renderer.setPixelRatio(basePixelRatio);
    }
    needsRender = false;
    render(now);
    if (!moving && degraded) needsRender = true;
  } else if (!moving && degraded && now - interactEnd > 250) {
    degraded = false; slowFrames = 0; renderer.setPixelRatio(basePixelRatio); needsRender = true;
  }
  if (now - fpsT0 > 1000) {
    fps = (frames * 1000) / (now - fpsT0);
    frames = 0; fpsT0 = now;
    const info = renderer.info.render;
    $('stPerf').textContent = active && !active.loading
      ? `${fps > 1.5 ? fps.toFixed(0) + ' fps' : '대기'} · 렌더 ${lastRenderMs.toFixed(1)} ms · draw ${info.calls}${degraded ? ' · 저해상도' : ''}` : '';
  }
}
requestAnimationFrame(loop);

// test / automation hook (used for performance verification)
window.__sv = {
  // load an already-parsed result (synthetic models in tests)
  loadResult: (name, result) => {
    const tab = createTab(name);
    activateTab(tab);
    buildModel(tab, result);
    tab.loading = false;
    controls.enabled = true;
    $('loading').classList.add('hidden');
    renderTabs(); renderTree(); updateStatus(); syncSectionUI();
    requestRender();
    return tab;
  },
  snapHit, applySection, sectionHandleAt, fitCylinderFace, workerAssetsReady,
  get persistentGeometries() { let n = 0; originScene.traverse((o) => { if (o.geometry) n++; }); return n; },
  get tabs() { return tabs; }, get active() { return active; }, THREE, renderer, controls, setView, setMode, selectParts, pick, pool,
  loadUrl: (url, name) => loadBuffer(name || url.split('/').pop(), async () => (await fetch(url)).arrayBuffer(), 0),
  stats: () => ({ fps, lastRenderMs, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, tabs: tabs.length,
    loading: tabs.some((t) => t.loading), loadTimes: tabs.map((t) => ({ name: t.name, ms: t.loadTimeMs, parts: t.parts.length, tris: t.triCount })) }),
};
