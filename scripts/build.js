// Builds dist/StepViewer.exe : a single self-contained executable (Node SEA) with the web app embedded.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const build = path.join(root, 'build');
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(build, { recursive: true });

// 1. refresh vendor files
require('./vendor.js');

// 2. collect app assets
const assets = {};
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else assets[path.relative(root, p).split(path.sep).join('/')] = p;
  }
};
walk(path.join(root, 'app'));
assets['package.json'] = path.join(root, 'package.json'); // version for the update check
console.log(`embedding ${Object.keys(assets).length} assets`);

// 3. SEA blob
const cfgPath = path.join(build, 'sea-config.json');
const blob = path.join(build, 'sea-prep.blob');
fs.writeFileSync(cfgPath, JSON.stringify({
  main: path.join(root, 'server.js'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

// 4. copy node.exe and inject
// `npm run build -- --out dist/x.exe` writes elsewhere (e.g. while StepViewer.exe is running)
const outIdx = process.argv.indexOf('--out');
const exe = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(dist, 'StepViewer.exe');
try { fs.rmSync(exe, { force: true }); } catch (e) { throw new Error(`${exe} is in use – close StepViewer first`); }
fs.copyFileSync(process.execPath, exe);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'], { stdio: 'inherit' });

// 5. switch PE subsystem to GUI so no console window appears (logs go to %TEMP%\StepViewer.log)
const buf = fs.readFileSync(exe);
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') throw new Error('not a PE file');
const optHeader = peOff + 24;
const subsystemOff = optHeader + 68; // same offset for PE32 and PE32+
const before = buf.readUInt16LE(subsystemOff);
buf.writeUInt16LE(2, subsystemOff); // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(exe, buf);
console.log(`subsystem ${before} -> 2 (GUI)`);
console.log(`built ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
