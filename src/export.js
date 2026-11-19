// 导出：Obsidian vault、JSON 全量、Markdown 合集、store-only zip。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ASSETS_DIR } from './config.js';

const ILLEGAL = /[\\/:*?"<>|]/g;

export function safeFilename(name, fallback = 'item') {
  const s = String(name || '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

function yamlEscape(v) {
  const s = String(v ?? '');
  return JSON.stringify(s);
}

// 条目 → Obsidian 风格 .md
export function itemToMarkdown(item, tags, props, assets = [], links = []) {
  const lines = ['---'];
  lines.push(`id: ${item.id}`);
  lines.push(`kind: ${item.kind}`);
  if (tags.length) lines.push(`tags: [${tags.map(t => yamlEscape(t)).join(', ')}]`);
  if (item.source_url) lines.push(`source: ${yamlEscape(item.source_url)}`);
  if (item.source_platform) lines.push(`platform: ${yamlEscape(item.source_platform)}`);
  lines.push(`created: ${yamlEscape(item.created_at)}`);
  for (const [k, v] of Object.entries(props || {})) {
    lines.push(`${k}: ${yamlEscape(v)}`);
  }
  lines.push('---', '', item.content || '', '');
  // 双向链接：items 表里的 [[link]] 转成 markdown 链接
  const linkMap = new Map(links.map(l => [l.dst_id, l.title]));
  if (linkMap.size) {
    lines.push('## 相关条目');
    for (const [id, title] of linkMap) {
      lines.push(`- [[${title}]]`);
    }
    lines.push('');
  }
  // 图片资产：assets 表里的图片转成 markdown 图片语法
  const assetFiles = assets.filter(a => a.kind === 'gallery' && a.path);
  if (assetFiles.length) {
    lines.push('## 图片');
    for (const a of assetFiles) {
      const fname = path.basename(a.path || a.sha256);
      lines.push(`![[assets/${fname}]]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// 最小 store-only zip 实现（无压缩，UTF-8 文件名）
export function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(0, 8);      // store
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 30);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, eocd]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Obsidian 导出：写入 vault 目录或返回 zip 条目
export function exportToObsidian(store, { onlyCurated = false, outDir = null } = {}) {
  const db = store.db;
  const where = onlyCurated ? "WHERE status='curated'" : "WHERE status IN ('inbox','curated','archived')";
  const items = db.prepare(`SELECT * FROM items ${where} ORDER BY id`).all();
  const entries = [];
  const usedNames = new Map();
  for (const it of items) {
    const tags = db.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?').all(it.id).map(r => r.name);
    const props = JSON.parse(it.props_json || '{}');
    const galleryAssets = db.prepare('SELECT * FROM assets WHERE item_id=?').all(it.id);
    const links = db.prepare('SELECT l.dst_id, i.title FROM links l JOIN items i ON i.id=l.dst_id WHERE l.src_id=?').all(it.id);
    const md = itemToMarkdown(it, tags, props, galleryAssets, links);
    let base = safeFilename(it.title, `item-${it.id}`);
    let fname = `${base}.md`;
    let n = 1;
    while (usedNames.has(fname.toLowerCase()) && usedNames.get(fname.toLowerCase()) !== it.id) {
      fname = `${base}-${++n}.md`;
    }
    usedNames.set(fname.toLowerCase(), it.id);
    entries.push({ name: fname, data: md });
    // 图片资产导出到 assets/ 目录
    for (const a of galleryAssets) {
      const fname = path.basename(a.path || a.sha256);
      try { entries.push({ name: `assets/${fname}`, data: fs.readFileSync(path.join(ASSETS_DIR, a.path || '')) }); } catch { }
    }
  }
  // 生成 _links.md：条目间链接索引
  const linkMap = new Map();
  for (const it of items) {
    const links = db.prepare('SELECT l.dst_id, i.title FROM links l JOIN items i ON i.id=l.dst_id WHERE l.src_id=?').all(it.id);
    if (links.length) {
      linkMap.set(it.title || `item-${it.id}`, links.map(l => l.title));
    }
  }
  if (linkMap.size) {
    const linkLines = ['# 条目关联', ''];
    for (const [src, dsts] of linkMap) {
      linkLines.push(`- **${src}** → ${dsts.map(t => `[[${t}]]`).join(', ')}`);
    }
    entries.push({ name: '_links.md', data: linkLines.join('\n') });
  }
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    for (const e of entries) fs.writeFileSync(path.join(outDir, e.name), e.data);
  }
  return entries;
}

export function exportJson(store) {
  const db = store.db;
  return JSON.stringify({
    version: 1,
    exported_at: new Date().toISOString(),
    items: db.prepare('SELECT * FROM items').all(),
    tags: db.prepare('SELECT * FROM tags').all(),
    item_tags: db.prepare('SELECT * FROM item_tags').all(),
    links: db.prepare('SELECT * FROM links').all(),
    collections: db.prepare('SELECT * FROM collections').all(),
    collection_items: db.prepare('SELECT * FROM collection_items').all(),
    item_files: db.prepare('SELECT * FROM item_files').all(),
  }, null, 2);
}

export function importJson(store, json) {
  const db = store.db;
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  let count = 0;
  const tagIdByName = new Map();
  for (const t of data.tags || []) {
    const row = db.prepare('SELECT id FROM tags WHERE name=?').get(t.name);
    tagIdByName.set(t.name, row ? row.id : null);
  }
  for (const it of data.items || []) {
    const exists = it.content_hash && db.prepare('SELECT id FROM items WHERE content_hash=?').get(it.content_hash);
    if (exists) continue;
    const r = db.prepare(`INSERT INTO items(kind,title,content,raw,summary,source_type,source_url,source_platform,lang,status,favorite,use_count,props_json,content_hash,simhash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(it.kind || 'unknown', it.title || '', it.content || '', it.raw || it.content || '',
        it.summary || '', it.source_type || 'import', it.source_url || '', it.source_platform || '',
        it.lang || '', it.status || 'inbox', it.favorite ? 1 : 0, it.use_count || 0,
        it.props_json || '{}', it.content_hash || '', it.simhash || '',
        it.created_at || new Date().toISOString(), it.updated_at || new Date().toISOString());
    count++;
    const newId = r.lastInsertRowid;
    for (const rel of (data.item_tags || []).filter(x => x.item_id === it.id)) {
      const tagRow = (data.tags || []).find(t => t.id === rel.tag_id);
      if (!tagRow) continue;
      let tagId = tagIdByName.get(tagRow.name);
      if (!tagId) {
        tagId = db.prepare('INSERT INTO tags(name,aliases_json,status) VALUES(?,?,?)').run(tagRow.name, tagRow.aliases_json || '[]', 'active').lastInsertRowid;
        tagIdByName.set(tagRow.name, tagId);
      }
      db.prepare('INSERT INTO item_tags(item_id,tag_id,source,confidence) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
        .run(newId, tagId, rel.source || 'user', rel.confidence ?? 1);
    }
    store.ftsUpdate(newId);
  }
  return count;
}

export function promptsToMarkdown(store) {
  const db = store.db;
  const items = db.prepare("SELECT * FROM items WHERE kind='prompt' AND status IN ('inbox','curated') ORDER BY title").all();
  const lines = ['# Prompts 合集', ''];
  for (const it of items) {
    lines.push(`## ${it.title || '(未命名)'}`, '', '```', it.content, '```', '');
    if (it.summary) lines.push(`> ${it.summary}`, '');
  }
  return lines.join('\n');
}
