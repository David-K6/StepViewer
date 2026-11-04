// Builds the static web version into build/web (deployed to GitHub Pages by .github/workflows/pages.yml).
// Same app/ as the exe; the meta tag switches off everything that needs the local server
// (opened-file events, updater, window lifetime). Run `npm run vendor` first.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'app');
const out = path.join(root, 'build', 'web');

if (!fs.existsSync(path.join(src, 'vendor', 'occt-import-js.wasm'))) {
  console.error('app/vendor is missing: run `npm run vendor` first');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const index = path.join(out, 'index.html');
const html = fs.readFileSync(index, 'utf8');
const marker = '<meta charset="utf-8">';
if (!html.includes(marker)) { console.error(`index.html: "${marker}" not found`); process.exit(1); }
const version = require(path.join(root, 'package.json')).version;
fs.writeFileSync(index, html.replace(marker, `${marker}\n<meta name="stepviewer-mode" content="web">\n<meta name="stepviewer-version" content="${version}">`));
fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is

let n = 0, bytes = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { n++; bytes += fs.statSync(f).size; } } })(out);
console.log(`web build ${version}: ${out} (${n} files, ${(bytes / 1048576).toFixed(1)} MB)`);
