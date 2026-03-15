#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { input: '', output: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i] || '';
    else if (a === '--output') args.output = argv[++i] || '';
  }
  if (!args.input || !args.output) {
    console.error('Usage: node normalize_pingpong_merged_tutorials.js --input <favorites.json> --output <tutorials.json>');
    process.exit(2);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function splitFolderTags(folderTitle) {
  if (!folderTitle) return [];
  let s = String(folderTitle).trim();
  s = s.replace(/^乒乓_/, '');
  const parts = s.split(/[_/]/g).map(p => p.trim()).filter(Boolean);
  const tags = [];
  for (const p of parts) {
    // Split combined phrases: "发球及发抢" -> "发球", "发抢"
    const sub = p.split(/[及和与]/g).map(x => x.trim()).filter(Boolean);
    tags.push(...sub);
  }
  return tags;
}

function extractHashtags(text) {
  if (!text) return [];
  const s = String(text);
  const raw = s.split(/[#＃]/g).slice(1);
  const tags = [];
  for (const t of raw) {
    const token = t.split(/\s+/g)[0]?.trim();
    if (!token) continue;
    if (token === '乒乓球' || token === '竞技体育' || token === '教学' || token === '体育精神') continue;
    if (token.length > 20) continue;
    tags.push(token);
  }
  return tags;
}

function normalizeText(x) {
  return (x == null ? '' : String(x)).trim();
}

function deriveFallbackTitle(item) {
  const title = normalizeText(item.title);
  if (title) return title.slice(0, 120);
  const desc = normalizeText(item.description);
  if (desc) {
    const head = desc.split(/[#＃]/g)[0].trim();
    return (head || desc).slice(0, 120);
  }
  return `${item.platform || 'unknown'}_video_${item.item_id || 'unknown'}`;
}

function buildActionMatcher() {
  // High-confidence only. Keep conservative to avoid wrong binding.
  return [
    { action_id: 'bh_flick', patterns: ['反手拧拉', '霸王拧', '反手拧', '台内拧'] },
    { action_id: 'fh_loop', patterns: ['正手拉球', '正手弧圈', '正手冲拉', '正手拉下旋', '正手拉上旋', '正手暴冲'] },
    { action_id: 'fh_drive', patterns: ['正手攻球', '正手攻'] },
    { action_id: 'bh_loop', patterns: ['反手拉球', '反手弧圈', '反手起下旋'] },
    { action_id: 'bh_drive', patterns: ['反手拨球', '反手快拨', '反手拨'] },
    { action_id: 'bh_block', patterns: ['反手防弧圈', '反手挡', '反手封堵'] },
    { action_id: 'fh_block', patterns: ['正手防弧圈', '正手挡', '减力挡'] },
    { action_id: 'serve_spin', patterns: ['下旋发球', '发下旋'] },
    { action_id: 'hook_serve', patterns: ['勾手发球'] },
    { action_id: 'reverse_pendulum_serve', patterns: ['逆旋转发球', '逆旋转'] },
    { action_id: 'receive', patterns: ['接发球', '接发', '摆短', '劈长'] },
  ];
}

function matchActionIds(text) {
  if (!text) return [];
  const s = String(text);
  const hits = [];
  for (const rule of buildActionMatcher()) {
    for (const p of rule.patterns) {
      if (s.includes(p)) {
        hits.push(rule.action_id);
        break;
      }
    }
  }
  return hits;
}

function normalizeMergedFavoritesJson(inputPath) {
  const raw = readJson(inputPath);
  const items = raw.items || [];

  const byId = new Map(); // tutorial_id -> normalized
  for (const it of items) {
    const platform = normalizeText(it.platform);
    const itemId = normalizeText(it.item_id || it.aweme_id || it.bvid);
    if (!platform || !itemId) continue;

    const tutorial_id = `${platform}:${itemId}`;
    const folderTitle = normalizeText(it.folder_title);
    const title = deriveFallbackTitle(it);
    const url = normalizeText(it.url);
    const author = it.author == null ? null : String(it.author);
    const desc = normalizeText(it.description);

    const folderTags = splitFolderTags(folderTitle);
    const hashTags = extractHashtags(desc);

    const related_action_ids = uniq([
      ...matchActionIds(folderTitle),
      ...matchActionIds(title),
      ...matchActionIds(desc),
    ]);

    const createdTime = it.created_time == null ? null : it.created_time;
    const savedTime = it.saved_time == null ? null : it.saved_time;

    const current = byId.get(tutorial_id) || {
      tutorial_id,
      platform,
      platform_item_id: itemId,
      title,
      url: url || (platform === 'douyin' ? `https://www.douyin.com/video/${itemId}` : ''),
      author,
      source_folder_titles: [],
      tags: [],
      related_action_ids: [],
      related_tactic_ids: [],
      quality_score: 0,
      status: 'active',
      last_verified_at: null,
      created_time: createdTime,
      saved_time: savedTime,
      duration: it.duration == null ? null : it.duration,
      description: desc || null,
      raw: {},
    };

    current.source_folder_titles = uniq([...current.source_folder_titles, folderTitle]);
    current.tags = uniq([...current.tags, ...folderTags, ...hashTags]).slice(0, 16);
    current.related_action_ids = uniq([...current.related_action_ids, ...related_action_ids]);

    // Prefer non-empty author/title/url/description on merge.
    if (!current.author && author) current.author = author;
    if (!current.title && title) current.title = title;
    if ((!current.url || current.url.length < 10) && url) current.url = url;
    if (!current.description && desc) current.description = desc;

    // Keep earliest created_time if numeric.
    const ct = Number(createdTime || 0) || null;
    const prevCt = Number(current.created_time || 0) || null;
    if (ct && (!prevCt || ct < prevCt)) current.created_time = ct;

    // Keep latest saved_time if numeric.
    const st = Number(savedTime || 0) || null;
    const prevSt = Number(current.saved_time || 0) || null;
    if (st && (!prevSt || st > prevSt)) current.saved_time = st;

    current.raw = {
      ...(current.raw || {}),
      item_id: itemId,
      item_id_type: it.item_id_type || null,
      bvid: it.bvid || null,
      aid: it.aid || null,
      aweme_id: it.aweme_id || null,
    };

    byId.set(tutorial_id, current);
  }

  const tutorials = Array.from(byId.values()).sort((a, b) => {
    const at = Number(a.saved_time || 0) || 0;
    const bt = Number(b.saved_time || 0) || 0;
    return bt - at;
  });

  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    source: {
      input_path: inputPath,
      sources: raw.sources || null,
      counts: raw.counts || null,
      row_count: items.length,
      unique_count: tutorials.length,
    },
    tutorials,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const normalized = normalizeMergedFavoritesJson(args.input);
  writeJson(args.output, normalized);
  console.log(`Wrote ${normalized.tutorials.length} tutorials to ${args.output}`);
}

main();

