import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const distDir = path.join(projectDir, 'dist');
const errors = [];
const warnings = [];

function requireFile(relativePath) {
  const absolutePath = path.join(distDir, relativePath);
  if (!fs.existsSync(absolutePath)) errors.push(`缺少构建文件：${relativePath}`);
  return absolutePath;
}

const manifestPath = requireFile('manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.manifest_version !== 3) errors.push('manifest_version 必须为 3');
if (manifest.background?.service_worker) requireFile(manifest.background.service_worker);
if (manifest.action?.default_popup) requireFile(manifest.action.default_popup);
if (manifest.options_ui?.page) requireFile(manifest.options_ui.page);
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) requireFile(file);
  for (const file of script.css || []) requireFile(file);
}
for (const file of Object.values(manifest.icons || {})) requireFile(file);

if ((manifest.permissions || []).includes('offscreen')) {
  requireFile('offscreen.html');
  requireFile('offscreen.js');
}

const forbiddenPermissions = ['cookies', 'webRequest', 'webRequestBlocking', 'debugger'];
for (const permission of forbiddenPermissions) {
  if ((manifest.permissions || []).includes(permission)) errors.push(`不应申请高权限：${permission}`);
}

const builtFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else builtFiles.push(fullPath);
  }
}
walk(distDir);

for (const file of builtFiles.filter((item) => item.endsWith('.js'))) {
  const content = fs.readFileSync(file, 'utf8');
  if (/\beval\s*\(/.test(content)) errors.push(`${path.relative(distDir, file)} 含 eval()`);
  if (/new\s+Function\s*\(/.test(content)) errors.push(`${path.relative(distDir, file)} 含 new Function()`);
}

for (const file of builtFiles.filter((item) => item.endsWith('.html'))) {
  const content = fs.readFileSync(file, 'utf8');
  if (/<script[^>]+src=["']https?:/i.test(content)) errors.push(`${path.relative(distDir, file)} 引用了远程脚本`);
  if (/<script(?![^>]+src=)[^>]*>/i.test(content)) errors.push(`${path.relative(distDir, file)} 含内联脚本`);
}

const background = fs.readFileSync(requireFile('background.js'), 'utf8');
if (!background.includes('chrome.runtime.onMessage')) warnings.push('background.js 未检测到消息监听器文本');

if (warnings.length) console.warn(warnings.map((item) => `警告：${item}`).join('\n'));
if (errors.length) {
  console.error(errors.map((item) => `错误：${item}`).join('\n'));
  process.exit(1);
}
console.log(`构建校验通过：${builtFiles.length} 个文件，Manifest V${manifest.manifest_version}`);
