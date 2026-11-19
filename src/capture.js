// 抓取入库：文本 / URL / 图片 → 条目 + 资产 + 后台 jobs。
// 要求：capture 接口快速返回，AI 全部走 jobs 队列。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from './config.js';
import { cleanText } from './clean.js';
import { contentHash, simhash, findDuplicates, normalizeUrl } from './dedupe.js';
import { IMAGE_MIMES, MAX_IMAGE_BYTES, fetchPage } from './security.js';
import { heuristicTags, TagService } from './tags.js';

export function platformOf(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    const map = [
      [/x\.com|twitter\.com/, 'x'], [/xiaohongshu\.com|xhslink\.com/, '小红书'],
      [/weibo\.(com|cn)/, '微博'], [/zhihu\.com/, '知乎'], [/reddit\.com/, 'reddit'],
      [/github\.com/, 'github'], [/mp\.weixin\.qq\.com/, '微信公众号'],
      [/bilibili\.com|b23\.tv/, 'bilibili'], [/v2ex\.com/, 'v2ex'],
      [/juejin\.cn/, '掘金'], [/douyin\.com/, '抖音'],
    ];
    for (const [re, name] of map) if (re.test(h)) return name;
    return h;
  } catch { return ''; }
}

export function detectLang(text) {
  const t = String(text || '');
  const cjk = (t.match([/一-鿿/g]) || []).length;
  if (!t.length) return '';
  return cjk / Math.min(t.length, 2000) > 0.15 ? 'zh' : 'en';
}

export function parseWikilinks(text) {
  return [...String(text || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
}

export class Capture {
  constructor(store, { fetchImpl = fetch } = {}) {
    this.store = store;
    this.db = store.db;
    this.tags = new TagService(this.db);
    this.fetch = fetchImpl;
  }

  // 主入口：{text, url, title, source, selection, html, images:[{buffer,mime}|dataURL], splitImages:bool}
  async capture({ text = '', url = '', title = '', source = '', selection = '', html = '', images = [], kindHint = '', sourceType = '', splitImages = false } = {}) {
    // 多张图且要求分开 → 每张图独立成一条 item
    if (splitImages && images.length > 1) {
      const items = [];
      for (const img of images) {
        const r = await this.capture({ text, url, title, source, selection, html, images: [img], kindHint, sourceType, splitImages: false });
        if (r.items?.length) items.push(...r.items);
      }
      return { duplicate: { exact: [], near: [] }, items };
    }
    const raw = [selection, text].filter(Boolean).join('\n\n');
    const result = { duplicate: null, items: [] };

    let bodyText = raw;
    let pageMeta = {};
    let fetchFailed = false;
    if (url && !bodyText) {
      try {
        const page = await this.fetchArticle(url, html);
        if (page) {
          bodyText = page.text;
          pageMeta = { title: page.title, ogImage: page.ogImage };
        }
        if (!bodyText) fetchFailed = true;
      } catch (e) {
        // SSRF/格式校验类安全错误不能吞，直接上抛让接口返回 400/403
        if (e?.statusCode || e?.status === 400 || /SSRF|内网|不允许|格式/i.test(e?.message || '')) throw e;
        fetchFailed = true;
      }
    }

    if (fetchFailed && !bodyText) bodyText = `${title ? `【${title}】\n` : ''}${url}\n\n_抓取失败：未能获取网页正文（可能需要 JS 渲染、登录或被反爬）。_`;
    const { cleaned, removed, hashtagCandidates } = cleanText(bodyText || (title ? `【${title}】\n${url}` : ''));
    // 纯图片条目没有文本，空字符串的 hash 会让所有图片误判为重复；只有有文本时才算 hash
    const textForHash = (cleaned || bodyText || '').trim();
    const hash = textForHash ? contentHash(textForHash) : '';
    const sim = textForHash ? simhash(textForHash) : '';

    // 同一网页的不同选区是独立内容，选区只按文本 hash 去重，不按来源 URL 去重
    const isSelection = source === 'extension-selection' || sourceType === 'selection';
    const dup = findDuplicates(this.db, { contentHash: hash, simhash: sim, url: isSelection ? '' : url, excludeId: 0 });
    if (dup.exact.length) {
      return { duplicate: { exact: dup.exact, near: dup.near }, items: [] };
    }

    const now = new Date().toISOString();
    const platform = platformOf(url);
    const st = sourceType || (source === 'extension-selection' ? 'selection' : images.length ? 'image' : url ? 'web' : 'manual');
    const r = this.db.prepare(`INSERT INTO items(kind,title,content,raw,summary,source_type,source_url,source_platform,lang,status,props_json,content_hash,simhash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(kindHint || 'unknown',
        (title || pageMeta.title || '').slice(0, 200) || firstLine(cleaned) || (images.length ? '截图' : '(未命名)'),
        cleaned, bodyText, '', st, url, platform,
        detectLang(cleaned), 'inbox', '{}', hash, sim, now, now);
    const itemId = r.lastInsertRowid;

    // 图片入库（sha256 去重）：用户上传 + URL 抓取到的页面图（多页图文）
    const assetIds = [];
    for (const img of images) {
      try {
        const id = this.saveAsset(itemId, img);
        if (id) assetIds.push(id);
      } catch { /* 单图失败不阻塞 */ }
    }
    if (pageMeta.images?.length && !images.length) {
      for (const iu of pageMeta.images) {
        try {
          const { buffer, contentType } = await fetchPage(iu, { fetchImpl: this.fetch, maxBytes: 8 * 1024 * 1024 });
          if (/image\//i.test(contentType) && buffer.length > 4000) {
            const id = this.saveAsset(itemId, { name: 'page' + (iu.split('/').pop() || '.jpg'), buffer, mime: contentType.split(';')[0] });
            if (id) assetIds.push(id);
          }
        } catch { /* 单图失败不阻塞 */ }
      }
    }

    // 规则清洗记录；标签只作为建议保存，经分类方案确认后才落库
    const notes = { removed, hashtagCandidates };
    if (this.store.settings.get('auto_classify') !== '0' && !this.store.settings.get('llm_api_key')) {
      notes.suggested_tags = heuristicTags(cleaned, hashtagCandidates);
    }
    if (removed.length || hashtagCandidates.length || notes.suggested_tags) {
      this.db.prepare('UPDATE items SET ai_notes=? WHERE id=?').run(JSON.stringify(notes), itemId);
    }

    // 入队异步任务
    const jobs = [];
    if (this.store.settings.get('auto_clean') !== '0' || this.store.settings.get('auto_classify') !== '0') {
      jobs.push(['classify', itemId]);
    }
    if (assetIds.length && this.store.settings.get('auto_ocr') !== '0') {
      jobs.push(['ocr', itemId]);
    }
    for (const [type, id] of jobs) {
      this.db.prepare('INSERT INTO jobs(item_id,type,payload_json) VALUES(?,?,?)').run(id, type, '{}');
    }
    if (jobs.length) {
      this.db.prepare('UPDATE items SET processing=? WHERE id=?').run(jobs.map(j => j[0]).join(','), itemId);
    }

    this.store.ftsUpdate(itemId);
    return { duplicate: { exact: [], near: dup.near }, items: [this.getItem(itemId)] };
  }

  getItem(id) {
    const it = this.db.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (it) {
      it.tags = this.tags.tagsOfItem(id);
      it.assets = this.db.prepare('SELECT id,sha256,mime,ocr_state,vision_desc,width,height,kind FROM assets WHERE item_id=?').all(id);
      const notes = JSON.parse(it.ai_notes || '{}');
      const llmRemoved = [].concat(notes.llm_removed || []).filter(Boolean).map(t => ({ text: typeof t === 'string' ? t : JSON.stringify(t), reason: 'llm' }));
      it.removed = [...(notes.removed || []), ...llmRemoved];
    }
    return it;
  }

  saveAsset(itemId, { buffer, mime, kind = 'gallery' }) {
    if (!IMAGE_MIMES.has(mime)) throw new Error(`不支持的图片类型 ${mime}`);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片过大');
    const sha = createHash('sha256').update(buffer).digest('hex');
    const existing = this.db.prepare('SELECT id,item_id,path FROM assets WHERE sha256=?').get(sha);
    if (existing) {
      // 图片内容重复：共享同一物理文件，给新 item 挂一条 duplicate 资产记录（含 OCR 结果，不再重复识别）
      const src = this.db.prepare('SELECT * FROM assets WHERE sha256=? LIMIT 1').get(sha);
      const r = this.db.prepare('INSERT INTO assets(item_id,path,sha256,mime,ocr_state,ocr_text,ocr_provider,vision_desc,width,height,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(itemId, existing.path || '', sha, mime, 'duplicate', src?.ocr_text || '', src?.ocr_provider || '', src?.vision_desc || '', src?.width || 0, src?.height || 0, kind);
      return r.lastInsertRowid;
    }
    const fname = sha.slice(0, 24) + IMAGE_MIMES.get(mime);
    const fpath = path.join(ASSETS_DIR, fname);
    fs.writeFileSync(fpath, buffer);
    const r = this.db.prepare('INSERT INTO assets(item_id,path,sha256,mime,kind) VALUES(?,?,?,?,?)')
      .run(itemId, fname, sha, mime, kind);
    return r.lastInsertRowid;
  }

  // URL 抓取：Readability 正文 + og 元数据；GitHub raw 特判
  async fetchArticle(url, providedHtml = '') {
    const gh = githubRaw(url);
    if (gh) {
      try {
        const text = await this.fetchText(gh);
        return { title: decodeURIComponent(gh.split('/').pop() || ''), text, ogImage: '' };
      } catch { /* 继续走 HTML */ }
    }
    let html = providedHtml;
    if (!html) {
      const { buffer, contentType } = await fetchPage(url, { fetchImpl: this.fetch });
      if (!/html|text/i.test(contentType)) throw new Error('目标不是网页');
      html = buffer.toString('utf8');
    }
    const { parseHTML } = await import('linkedom');
    const { Readability } = await import('@mozilla/readability');
    const { document } = parseHTML(html);
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '';
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    let text = '';
    try {
      const article = new Readability(document).parse();
      text = htmlToText(article?.content || '') || article?.textContent || '';
    } catch { }
    if (!text) text = document.body?.textContent || '';
    // 收集页面图片：og:image 各变体 + 正文大图（多页图文/小红书/相册帖）
    const imgUrls = new Set();
    for (const sel of ['meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[property="og:image:secure_url"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]']) {
      const u = document.querySelector(sel)?.getAttribute('content');
      if (u && /^https?:/i.test(u)) imgUrls.add(u);
    }
    // JSON-LD / link[rel=image_src] / 正文 <img>（取大图，跳过图标小图）
    const abs = (u) => { try { return new URL(u, url).href; } catch { return ''; } };
    document.querySelectorAll('link[rel="image_src"], img').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data-original');
      const w = parseInt(el.getAttribute('width') || el.naturalWidth || '0');
      const h = parseInt(el.getAttribute('height') || el.naturalHeight || '0');
      const u = abs(src);
      if (u && /^https?:/i.test(u) && (w >= 300 || h >= 300 || (!w && !h))) imgUrls.add(u);
    });
    return { title: ogTitle, text: text.trim(), ogImage, images: [...imgUrls].slice(0, 50) };
  }

  async fetchText(url, depth = 0) {
    const { buffer } = await fetchPage(url, { fetchImpl: this.fetch, maxBytes: 2 * 1024 * 1024 });
    return buffer.toString('utf8');
  }

  // 合并重复：保留 target，把 source 的来源/标签并入，source 进回收站
  mergeItems(targetId, sourceId) {
    const src = this.db.prepare('SELECT * FROM items WHERE id=?').get(sourceId);
    const tgt = this.db.prepare('SELECT * FROM items WHERE id=?').get(targetId);
    if (!src || !tgt) return;
    this.store.snapshot(targetId, 'merge');
    this.db.prepare('INSERT OR IGNORE INTO item_tags(item_id,tag_id,source,confidence) SELECT ?,tag_id,source,confidence FROM item_tags WHERE item_id=?').run(targetId, sourceId);
    if (src.source_url && !tgt.source_url) {
      this.db.prepare('UPDATE items SET source_url=?, source_platform=? WHERE id=?').run(src.source_url, src.source_platform, targetId);
    }
    const srcUrls = JSON.parse(tgt.props_json || '{}').merged_sources || [];
    srcUrls.push({ url: src.source_url, title: src.title, id: src.id });
    const props = { ...JSON.parse(tgt.props_json || '{}'), merged_sources: srcUrls };
    this.db.prepare('UPDATE items SET props_json=? WHERE id=?').run(JSON.stringify(props), targetId);
    this.db.prepare("UPDATE items SET status='trash', deleted_at=datetime('now') WHERE id=?").run(sourceId);
    this.db.prepare('UPDATE assets SET item_id=? WHERE item_id=?').run(targetId, sourceId);
    this.store.ftsUpdate(targetId);
    this.store.ftsUpdate(sourceId);
    this.store.touch(targetId);
  }

  syncLinks(itemId) {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
    if (!item) return;
    this.db.prepare('DELETE FROM links WHERE src_id=?').run(itemId);
    for (const link of parseWikilinks(item.content)) {
      const dst = this.db.prepare("SELECT id FROM items WHERE title=? AND status!='trash'").get(link);
      if (dst && dst.id !== itemId) {
        this.db.prepare('INSERT OR IGNORE INTO links(src_id,dst_id) VALUES(?,?)').run(itemId, dst.id);
      }
    }
  }
}

function firstLine(text) {
  const lines = String(text || '').split('\n');
  // 跳过 YAML frontmatter 块
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++; // 越过收尾 ---
  }
  for (; i < lines.length; i++) {
    const l = lines[i].trim().replace(/^#+\s*/, '').trim();
    // 取第一个含字母/数字/CJK 的非空行
    if (/[0-9A-Za-z一-鿿]/.test(l)) return l.slice(0, 60);
  }
  return '';
}

export function githubRaw(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'raw.githubusercontent.com') return url;
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    // /owner/repo/blob/branch/path → raw
    if (parts[2] === 'blob' && parts.length > 4) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
    }
    // /owner/repo → README raw 探测由调用方决定
    if (parts.length === 2) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main/README.md`;
    }
    return null;
  } catch { return null; }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}
