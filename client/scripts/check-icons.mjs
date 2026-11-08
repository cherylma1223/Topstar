#!/usr/bin/env node
/**
 * 图标字体覆盖检查
 *
 * 前端用的是图标字体的子集（见 scripts/build-icon-font.py），所以「源码里用了某个图标，
 * 但子集里没有它」会表现为页面上显示一个空白方块，而且不会有任何报错。
 * 这个脚本在构建前检查：源码里出现的所有图标名，是否都在子集里。
 *
 * 用法：
 *   node scripts/check-icons.mjs           缺图标时失败（exit 1）——用于 npm run build
 *   node scripts/check-icons.mjs --warn    缺图标时只警告——用于 npm run dev
 *
 * 图标名的识别规则必须和 build-icon-font.py 里的 USED_ICON_PATTERNS 保持一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META = path.join(ROOT, 'src/assets/fonts/material-symbols-outlined.subset.json');
const FONT = path.join(ROOT, 'src/assets/fonts/material-symbols-outlined.subset.woff2');
const SCAN_SUFFIXES = new Set(['.ts', '.tsx', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'scripts', '.git']);
const PATTERNS = [/['"`]([a-z][a-z0-9_]*)['"`]/g, />\s*([a-z][a-z0-9_]*)\s*</g];

const warnOnly = process.argv.includes('--warn');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_SUFFIXES.has(path.extname(entry.name))) yield full;
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(warnOnly ? 0 : 1);
}

if (!fs.existsSync(META) || !fs.existsSync(FONT)) {
  fail('找不到图标字体子集。请先运行：npm run build:icons（需要 Python，见 scripts/requirements-icons.txt）');
}

const { icons, known } = JSON.parse(fs.readFileSync(META, 'utf8'));
const inSubset = new Set(icons);
const validNames = new Set(known);

const usedBy = new Map(); // 图标名 → 用到它的文件
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    for (const [, token] of text.matchAll(pattern)) {
      if (!validNames.has(token)) continue;
      if (!usedBy.has(token)) usedBy.set(token, new Set());
      usedBy.get(token).add(path.relative(ROOT, file));
    }
  }
}

const missing = [...usedBy.keys()].filter(name => !inSubset.has(name)).sort();
if (missing.length > 0) {
  const detail = missing.map(n => `  - ${n}（${[...usedBy.get(n)].join('、')}）`).join('\n');
  fail(`源码里用了这些图标，但图标字体子集里没有，页面上会显示成空白方块：\n${detail}\n\n请运行 npm run build:icons 重新生成子集后提交生成的文件。`);
}

console.log(`✓ 图标检查通过：源码用到的 ${usedBy.size} 个图标都在子集里（子集共 ${icons.length} 个）`);
