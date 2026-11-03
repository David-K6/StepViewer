// Copies third-party runtime files from node_modules into app/vendor (fully offline app).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'app', 'vendor');

const files = [
  ['three/build/three.module.js', 'three.module.js'],
  ['three/build/three.core.js', 'three.core.js'],
  ['three/examples/jsm/controls/OrbitControls.js', 'addons/OrbitControls.js'],
  ['three/examples/jsm/renderers/CSS2DRenderer.js', 'addons/CSS2DRenderer.js'],
  ['three-mesh-bvh/build/index.module.js', 'three-mesh-bvh.module.js'],
  ['occt-import-js/dist/occt-import-js.js', 'occt-import-js.js'],
  ['occt-import-js/dist/occt-import-js.wasm', 'occt-import-js.wasm'],
];

fs.rmSync(out, { recursive: true, force: true });
for (const [src, dst] of files) {
  const d = path.join(out, dst);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(path.join(nm, src), d);
  console.log('vendor:', dst);
}
