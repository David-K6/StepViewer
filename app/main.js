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
const SEL_EMISSIVE = new THREE.Color(0x1f56b8);
const HOVER_EMISSIVE = new THREE.Color(0x2a2a2a);
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
class ParserPool {
  constructor(max) { this.max = max; this.idle = []; this.all = []; this.queue = []; this.seq = 0; }
  parse(name, buffer, quality) {
    return new Promise((resolve, reject) => { this.queue.push({ name, buffer, quality, resolve, reject }); this.pump(); });
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
      if (!w && this.all.length < this.max) { w = new Worker('worker.js'); this.all.push(w); }
      if (!w) return;
      clearTimeout(w._idleTimer);
      const job = this.queue.shift();
      const id = ++this.seq;
      const bytes = job.buffer.byteLength; // read before transfer detaches the buffer
      w.onmessage = (ev) => {
        if (bytes > BIG_FILE) this.kill(w);
        else {
          this.idle.push(w);
          w._idleTimer = setTimeout(() => this.kill(w), WORKER_IDLE_MS);
        }
        if (ev.data.ok) job.resolve(ev.data); else job.reject(new Error(ev.data.error));
        this.pump();
      };
      w.onerror = (e) => {
        this.kill(w);
        job.reject(new Error(e.message || '워커 오류 (메모리 부족일 수 있습니다)'));
        this.pump();
      };
      w.postMessage({ id, name: job.name, buffer: job.buffer, quality: job.quality }, [job.buffer]);
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
async function openFiles(fileList) {
  for (const f of fileList) {
    if (!/\.(step|stp|iges|igs|brep|brp)$/i.test(f.name)) { toast(`지원하지 않는 형식: ${f.name}`, true); continue; }
    loadBuffer(f.name, () => f.arrayBuffer(), f.size);
  }
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

async function contentHash(buffer) {
  try {
    if (!crypto.subtle) return null;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function loadBuffer(name, getBuffer, size) {
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
    const cacheKey = hash ? `v2|${quality}|${buffer.byteLength}|${hash}` : null;
    let result = cacheKey ? await cacheGet(cacheKey) : null;
    const fromCache = !!result;
    if (!result) {
      result = await pool.parse(name, buffer, quality);
      if (cacheKey && !tab.closed) cachePut(cacheKey, result);
    }
    if (tab.closed) return;
    const tParsed = performance.now();
    buildModel(tab, result);
    const tBuilt = performance.now();
    tab.loadInfo = `크기 ${(size / 1048576).toFixed(2)} MB · ${fromCache ? '캐시' : '해석'} ${((tParsed - t0) / 1000).toFixed(2)}s · 생성 ${((tBuilt - tParsed) / 1000).toFixed(2)}s`;
    tab.loadTimeMs = tBuilt - t0;
    tab.loading = false;
    console.info(`[StepViewer] ${name}: ${tab.loadInfo}`, result.timing);
    if (active === tab) {
      controls.enabled = true;
      $('loading').classList.add('hidden');
      renderTree(); updateStatus(); syncSectionUI(); updateProps();
    }
    renderTabs();
    scheduleBvhBuild(tab);
    requestRender();
  } catch (e) {
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
    const part = {
      id: i, name: m.name || '', mesh, material: mat, rgb, hasVertexColors: !!m.colors,
      visible: true, opacity: 1, edges: m.edges, faceFirst: m.faceFirst, faceLast: m.faceLast,
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
function effOpacity(tab, p) { return p.opacity * tab.globalOpacity; }
function applyPart(tab, p) {
  const o = effOpacity(tab, p);
  const m = p.material;
  m.opacity = o;
  m.transparent = o < 0.999;
  m.depthWrite = !m.transparent;
  p.mesh.visible = p.visible && o > 0.004;
  const e = tab.selection.has(p) ? SEL_EMISSIVE : tab.hover === p ? HOVER_EMISSIVE : BLACK;
  m.emissive.copy(e);
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

function animateCamera(tab, toPos, toTarget, toZoom, ms = 280) {
  const cam = tab.camera;
  if (cam.position.distanceToSquared(tab.target) < 1e-20) ms = 0; // degenerate start (fresh camera)
  if (ms <= 0) {
    camAnim = null;
    tab.target.copy(toTarget);
    cam.position.copy(toPos);
    cam.zoom = toZoom;
    cam.updateProjectionMatrix();
    cam.lookAt(tab.target);
    requestRender();
    return;
  }
  const fromPos = cam.position.clone(), fromTarget = tab.target.clone(), fromZoom = cam.zoom;
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
  animateCamera(tab, f.pos, f.target, f.zoom, animate ? 300 : 0);
}

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
  tab.camera.up.set(0, 0, 1);
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
  radius: '원/호 모서리를 클릭하면 반경·지름·중심을 측정합니다. 원형이 아닌 곳은 원주 위 3점을 클릭하세요.',
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

function addCircleMeasure(tab, circ, onPt, how) {
  const { center, radius, normal } = circ;
  const pts = [];
  const u = onPt.clone().sub(center).normalize();
  for (let i = 0; i < 64; i++) pts.push(center.clone().addScaledVector(u.clone().applyAxisAngle(normal, (i / 64) * Math.PI * 2), radius));
  const lines = [`<b>Ø ${fmt(radius * 2)} mm</b>  R ${fmt(radius)} mm`,
    `중심 (${fmt(center.x)}, ${fmt(center.y)}, ${fmt(center.z)})`,
    `축 (${fmt(normal.x, 4)}, ${fmt(normal.y, 4)}, ${fmt(normal.z, 4)}) · ${how}`];
  addMeasure(tab, 'radius', lines, `Ø${fmt(radius * 2)} R${fmt(radius)}`, center,
    [mkLine(pts, true), mkLine([center, onPt]), mkPoints([center, onPt])]);
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
  const c = sel[0].material.color.clone();
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
    p.material.color.copy(c);
    if (p.hasVertexColors) { p.material.vertexColors = false; p.hasVertexColors = false; p.material.needsUpdate = true; }
    const s = c.clone().convertLinearToSRGB();
    p.rgb = [s.r, s.g, s.b];
  }
  renderTree();
  requestRender();
};
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
$('btnClearMeasure').onclick = () => { if (!active) return; for (const m of active.measures) disposeMeasure(m); active.measures = []; renderMeasureList(); requestRender(); };

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
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, t: performance.now() }; camAnim = null; });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const b = down.b;
  down = null;
  if (moved > 4 || b !== 0) return;
  onClick(e);
});
canvas.addEventListener('pointermove', (e) => {
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
  addPendingPoint(hit);
}

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || e.target.tagName === 'SELECT') return;
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
    if (!$('help').classList.contains('hidden')) { $('help').classList.add('hidden'); return; }
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
    case 'p': toggleProjection(); break;
    case '0': setView(active, 'iso'); break;
    case '1': setView(active, 'front'); break;
    case '3': setView(active, 'right'); break;
    case '7': setView(active, 'top'); break;
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
$('btnHelpClose').onclick = () => $('help').classList.add('hidden');

function connectServer() {
  if (location.protocol === 'file:') return;
  const es = new EventSource('/api/events');
  es.addEventListener('openfiles', (ev) => {
    for (const f of JSON.parse(ev.data)) {
      loadBuffer(f.name, async () => {
        const r = await fetch(`/api/file/${f.id}`);
        if (!r.ok) throw new Error(`파일을 읽을 수 없습니다 (${r.status})`);
        return r.arrayBuffer();
      }, f.size);
    }
  });
  es.addEventListener('focus', () => window.focus());
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
    tctx.fillText(n, x + (v.x >= 0 ? 3 : -11), y + (v.y >= 0 ? -3 : 11));
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
  lastRenderMs = performance.now() - t0;
  labelRenderer.render(tab.overlay, tab.camera);
  drawTriad(tab.camera);
  frames++;
}
const emptyScene = new THREE.Scene();
const defaultCam = new THREE.PerspectiveCamera();

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
  snapHit, applySection,
  get tabs() { return tabs; }, get active() { return active; }, THREE, renderer, controls, setView, setMode, selectParts, pick, pool,
  loadUrl: (url, name) => loadBuffer(name || url.split('/').pop(), async () => (await fetch(url)).arrayBuffer(), 0),
  stats: () => ({ fps, lastRenderMs, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, tabs: tabs.length,
    loading: tabs.some((t) => t.loading), loadTimes: tabs.map((t) => ({ name: t.name, ms: t.loadTimeMs, parts: t.parts.length, tris: t.triCount })) }),
};
