#!/usr/bin/env node
/**
 * 构建产物检查：确认前端不依赖境外 CDN
 *
 * 国内网络访问不了 Google Fonts、cdn.tailwindcss.com、esm.sh 这类地址，页面会白屏或没有样式。
 * 构建完成后扫描 dist/，发现下面这些情况就让构建失败：
 *   1. index.html / CSS 里出现任何绝对的 http(s) 地址，或 import map
 *   2. 任何文件里出现已知的境外 CDN 域名
 *
 * 另外会列出「内容链接」（视频、封面图等写死在源码里的境外 / 第三方地址），只警告不失败：
 * 它们不是页面运行所必需的资源，但在国内同样打不开，需要产品上换成自有地址。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(ROOT, process.argv[2] || 'dist');

/** 页面运行所需资源的境外 CDN：出现即失败 */
const CDN_HOSTS = [
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com', 'cdn.tailwindcss.com',
  'esm.sh', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'cdn.skypack.dev', 'ga.jspm.io',
];
/** 内容链接：只警告 */
const CONTENT_HOSTS = ['drive.google.com', 'docs.google.com', 'youtube.com', 'youtu.be', 'img1.baidu.com'];
/**
 * XML 命名空间标识（如 SVG 的 http://www.w3.org/2000/svg）长得像网址，但只是标识符，浏览器不会去请求它。
 * Tailwind forms 插件的 CSS 里，下拉框箭头、复选框的 data: SVG 图片里就有。
 */
const XML_NAMESPACE = /^https?:\/\/www\.w3\.org\//;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

if (!fs.existsSync(DIST)) {
  console.error(`✗ 找不到构建产物目录 ${DIST}，请先运行 vite build`);
  process.exit(1);
}

const failures = [];
const warnings = new Map(); // 域名 → 出现的文件
const textFiles = [...walk(DIST)].filter(f => /\.(html|css|js|mjs|json|svg)$/.test(f));

for (const file of textFiles) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');

  for (const host of CDN_HOSTS) {
    if (text.includes(host)) failures.push(`${rel} 引用了境外 CDN：${host}`);
  }

  // index.html / CSS 里不应该有任何绝对地址
  if (/\.(html|css)$/.test(file)) {
    const urls = [...text.matchAll(/https?:\/\/[^\s"'()<>]+/g)].map(m => m[0]).filter(u => !XML_NAMESPACE.test(u));
    for (const url of urls) failures.push(`${rel} 里有绝对地址：${url}`);
    if (/type=["']importmap["']/.test(text)) failures.push(`${rel} 里有 import map`);
  }

  for (const host of CONTENT_HOSTS) {
    if (text.includes(host)) {
      if (!warnings.has(host)) warnings.set(host, new Set());
      warnings.get(host).add(rel);
    }
  }
}

if (warnings.size > 0) {
  console.warn('\n⚠ 内容链接（不影响页面运行，但国内可能打不开，需要产品上换成自有地址）：');
  for (const [host, files] of warnings) console.warn(`  - ${host}（${[...files].join('、')}）`);
}

if (failures.length > 0) {
  console.error('\n✗ 构建产物里还有境外依赖：');
  for (const f of [...new Set(failures)]) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

const totalKb = textFiles.reduce((n, f) => n + fs.statSync(f).size, 0) / 1024;
console.log(`✓ 构建产物检查通过：没有境外 CDN 依赖（已检查 ${textFiles.length} 个文本文件，约 ${totalKb.toFixed(0)} KB）`);
