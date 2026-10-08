import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const srcDir = path.join(projectDir, 'src');
const distDir = path.join(projectDir, 'dist');

if (!path.resolve(distDir).startsWith(path.resolve(projectDir) + path.sep)) {
  throw new Error('Refusing to clean output outside the project directory');
}
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, 'pages'), { recursive: true });
fs.mkdirSync(path.join(distDir, 'icons'), { recursive: true });

await build({
  entryPoints: {
    background: path.join(srcDir, 'background', 'service-worker.js'),
    content: path.join(srcDir, 'content', 'content.js'),
    offscreen: path.join(srcDir, 'offscreen.js'),
    'pages/manager': path.join(srcDir, 'pages', 'manager.js'),
    'pages/popup': path.join(srcDir, 'pages', 'popup.js')
  },
  outdir: distDir,
  bundle: true,
  format: 'iife',
  target: ['chrome109'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info'
});

const copies = [
  ['manifest.json', 'manifest.json'],
  ['content/content.css', 'content.css'],
  ['pages/manager.html', 'pages/manager.html'],
  ['pages/manager.css', 'pages/manager.css'],
  ['pages/popup.html', 'pages/popup.html'],
  ['pages/popup.css', 'pages/popup.css'],
  ['offscreen.html', 'offscreen.html']
];

for (const [from, to] of copies) {
  fs.copyFileSync(path.join(srcDir, from), path.join(distDir, to));
}

for (const size of [16, 32, 48, 128]) {
  fs.copyFileSync(path.join(projectDir, 'assets', `icon${size}.png`), path.join(distDir, 'icons', `icon${size}.png`));
}

for (const document of ['README.md']) {
  fs.copyFileSync(path.join(projectDir, document), path.join(distDir, document));
}

console.log(`Built extension in ${distDir}`);
