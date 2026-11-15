// Catch 服务端：Fastify + 鉴权 + SSE + 静态资源。
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, Store } from './db.js';
import { Capture, parseWikilinks } from './capture.js';
import { JobRunner } from './jobs.js';
import { Searcher } from './search.js';
import { TagService, normalizeTag } from './tags.js';
import { validateSkill, buildSkillMd, sanitizeName, parseFrontmatter } from './skill.js';
import { exportToObsidian, exportJson, importJson, promptsToMarkdown, makeZip, safeFilename } from './export.js';
import { originAllowed, IMAGE_MIMES, MAX_IMAGE_BYTES, fetchPage } from './security.js';
import { parseChatgptExport } from './importers/chatgpt.js';
import { parseClaudeExport } from './importers/claude.js';
import { parseTranscript } from './importers/transcript.js';
import { importVault } from './importers/obsidian.js';
import { candidatesFromSessions } from './importers/score.js';
import { LlmClient } from './llm.js';
import { PlanService } from './plans.js';
import { createOcrChain } from './ocr/index.js';
import { ASSETS_DIR, ensureDataDirs, DATA_DIR } from './config.js';
import { findDuplicates } from './dedupe.js';
import { cleanText } from './clean.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ORIGIN_RE = /^https?:\/\//;

export async function buildApp({ db = null, store = null, llm = null, ocr = null, fetchImpl = fetch, serveStatic = true } = {}) {
  ensureDataDirs();
  const theDb = db || openDb();
  const theStore = store || new Store(theDb);
  const capture = new Capture(theStore, { fetchImpl });
  const tags = new TagService(theDb);
  const searcher = new Searcher(theDb);

  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 12 } });
  if (serveStatic && fs.existsSync(PUBLIC_DIR)) {
    // 开发/本地工具：禁用浏览器启发式缓存，界面修改刷新即生效
    await app.register(fastifyStatic, { root: PUBLIC_DIR, index: ['index.html'], maxAge: 0, etag: true, lastModified: true, cacheControl: false,
      setHeaders: (res) => { res.header('Cache-Control', 'no-store'); } });
  }

  // SSE 客户端
  const sseClients = new Set();
  const emit = (type, data) => {
    const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) { try { res.raw.write(line); } catch { } }
  };
  const runner = new JobRunner(theStore, { llm, ocr, emit });
  const plans = new PlanService(theStore, { llm: llm || new LlmClient(theStore.settings, { fetchImpl }) });
  app.decorate('runner', runner);
  app.decorate('store', theStore);
  app.decorate('db', theDb);

  const captureToken = () => theStore.settings.ensureCaptureToken();
  captureToken();

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  // ---- 鉴权 / Origin / CSRF ----
  // GET/HEAD/OPTIONS 一律放行读接口；非 GET：同源浏览器免 token，
  // 跨源必须是白名单扩展 Origin 或带有效 Bearer token，其余 403。
  const bearerOk = (req) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m && m[1] === captureToken();
  };

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin || '';
    // CORS：仅对扩展和本机开放
    if (origin && originAllowed(origin, req.headers.host)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    } else if (req.method === 'OPTIONS') {
      return reply.code(403).send();
    }
    if (req.method === 'GET' || req.method === 'HEAD') return;
    // 非 GET
    if (bearerOk(req)) return;
    if (origin && !originAllowed(origin, req.headers.host)) {
      return reply.code(403).send({ error: 'Origin 不允许' });
    }
    // 无 Origin：允许（curl/本机脚本/同源表单），但浏览器跨站表单会带 Origin
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    reply.code(status).send({ error: err.message || 'internal error' });
  });

  // 预览拆分：返回分段结果不入库，供前端"先预览再拆"勾选
  app.post('/api/capture/preview', async (req) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return { segments: [] };
    // 只按 ===== 分隔拆分（空行是用户拼一条的自然分隔，不拆）
    const segs = text.split(/^={5,}\s*$/m).map(s => s.trim()).filter(Boolean);
    return { segments: segs.map(s => ({ text: s, preview: s.replace(/\s+/g, ' ').slice(0, 60) })) };
  });

  // ---------- 抓取 ----------
  app.post('/api/capture', async (req, reply) => {
    let payload = {};
    const images = [];
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.file) {
          const buf = await part.toBuffer();
          if (IMAGE_MIMES.has(part.mimetype)) images.push({ buffer: buf, mime: part.mimetype });
        } else {
          if (part.fieldname === 'payload') Object.assign(payload, JSON.parse(part.value || '{}'));
          else payload[part.fieldname] = part.value;
        }
      }
    } else {
      payload = req.body || {};
      for (const img of payload.images || []) {
        if (typeof img === 'string' && img.startsWith('data:')) {
          const m = img.match(/^data:(image\/\w+);base64,(.*)$/s);
          if (m && IMAGE_MIMES.has(m[1])) images.push({ buffer: Buffer.from(m[2], 'base64'), mime: m[1] });
        } else if (typeof img === 'string' && ORIGIN_RE.test(img)) {
          try {
            const { buffer, contentType } = await fetchPage(img, { fetchImpl, maxBytes: MAX_IMAGE_BYTES, accept: 'image/*' });
            const mime = contentType.split(';')[0].trim();
            if (IMAGE_MIMES.has(mime)) images.push({ buffer, mime });
          } catch { }
        }
      }
    }
    const url = (payload.url || '').trim();
    const text = (payload.text || '').trim();
    // 粘贴纯 URL → 视为链接抓取
    const looksLikeUrl = /^https?:\/\/\S+$/.test(text) && !text.includes(' ');
    const finalUrl = url || (looksLikeUrl ? text : '');
    const finalText = looksLikeUrl ? '' : text;
    if (!finalUrl && !finalText && !images.length && !payload.title) {
      return reply.code(400).send({ error: '没有可抓取的内容' });
    }

    // 批量：仅当 split 开启时，用单独一行 ===== 分隔多条；默认整段作为一条，避免含空行或 --- 的 prompt/SKILL.md 被拆坏
    const wantSplit = payload.split === true || payload.split === '1' || payload.split === 'true';
    const segments = wantSplit && finalText && !finalUrl ? splitBatch(finalText) : [finalText];
    const results = [];
    for (const seg of segments) {
      const r = await capture.capture({
        text: seg, url: finalUrl, title: payload.title, source: payload.source,
        selection: payload.selection, html: payload.html, images: segments.length === 1 ? images : [],
        kindHint: payload.kind || '', sourceType: payload.source_type || '',
        splitImages: payload.split_images === true || payload.split_images === '1' || payload.split_images === 'true',
      });
      results.push(r);
      if (r.duplicate?.exact?.length) break;
    }
    const first = results[0];
    return reply.send({
      ok: true,
      items: results.flatMap(r => r.items),
      duplicate: first?.duplicate || null,
      count: results.reduce((n, r) => n + r.items.length, 0),
    });
  });

  app.post('/api/capture/confirm', async (req, reply) => {
    // 用户选择「仍然保存」或「合并」
    const { action, targetId, sourceId, payload } = req.body || {};
    if (action === 'merge' && targetId && sourceId) {
      capture.mergeItems(Number(targetId), Number(sourceId));
      return { ok: true };
    }
    return reply.code(400).send({ error: '未知操作' });
  });

  // ---------- 条目 ----------
  app.get('/api/items', async (req) => {
    const q = String(req.query.q || '');
    const status = req.query.status || 'active';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const kind = req.query.kind;
    const favorite = req.query.favorite === '1';
    if (kind || favorite) {
      const where = [];
      const params = [];
      if (status === 'trash') where.push("status='trash'");
      else where.push("status!='trash'");
      if (kind) { where.push('kind=?'); params.push(kind); }
      if (favorite) where.push('favorite=1');
      if (status && status !== 'all' && status !== 'trash') {
        where.push('status IN (?,?)'); params.push('inbox', 'curated');
      }
      const rows = theDb.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = theDb.prepare(`SELECT COUNT(*) c FROM items WHERE ${where.join(' AND ')}`).get(...params).c;
      const ids = rows.map(r => r.id);
      const tagMap = tagsForItems(theDb, ids);
      return { rows: rows.map(r => ({ ...r, tags: tagMap.get(r.id) || [] })), total };
    }
    const { rows, total } = searcher.search(q, { status, limit, offset });
    const tagMap = tagsForItems(theDb, rows.map(r => r.id));
    const assetCount = new Map(theDb.prepare(`SELECT item_id id, COUNT(*) c FROM assets WHERE item_id IN (${rows.map(() => '?').join(',') || 'NULL'}) GROUP BY item_id`).all(...rows.map(r => r.id)).map(r => [r.id, r.c]));
    return { rows: rows.map(r => ({ ...r, tags: tagMap.get(r.id) || [], asset_count: assetCount.get(r.id) || 0 })), total };
  });

  app.get('/api/items/:id', async (req) => {
    const it = capture.getItem(Number(req.params.id));
    if (!it) return { error: 'not found' };
    it.files = theDb.prepare('SELECT path,content FROM item_files WHERE item_id=?').all(it.id);
    const rel = searcher.related(it.id);
    it.related = rel.related;
    it.backlinks = rel.backlinks;
    it.collections = theDb.prepare('SELECT c.* FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=?').all(it.id);
    it.links_out = theDb.prepare('SELECT l.dst_id id, i.title FROM links l JOIN items i ON i.id=l.dst_id WHERE l.src_id=?').all(it.id);
    return it;
  });

  app.patch('/api/items/:id', async (req) => {
    const id = Number(req.params.id);
    const it = theDb.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!it) return { error: 'not found' };
    const b = req.body || {};
    theStore.snapshot(id, 'edit');
    const fields = [];
    const params = [];
    for (const k of ['title', 'content', 'summary', 'kind', 'lang']) {
      if (b[k] !== undefined) { fields.push(`${k}=?`); params.push(String(b[k])); }
    }
    if (b.status !== undefined && ['inbox', 'curated', 'archived', 'trash'].includes(b.status)) {
      fields.push('status=?'); params.push(b.status);
      if (b.status === 'trash') fields.push("deleted_at=datetime('now')");
      else fields.push('deleted_at=NULL');
    }
    if (b.favorite !== undefined) { fields.push('favorite=?'); params.push(b.favorite ? 1 : 0); }
    if (b.props !== undefined) { fields.push('props_json=?'); params.push(JSON.stringify(b.props)); }
    else if (b.title !== undefined && String(b.title) !== it.title) {
      // 手动改过的标题锁定，之后 AI 重新整理不再覆盖
      const props = JSON.parse(it.props_json || '{}');
      props.title_locked = true;
      fields.push('props_json=?'); params.push(JSON.stringify(props));
    }
    if (b.raw !== undefined) { fields.push('raw=?'); params.push(String(b.raw)); }
    if (fields.length) {
      theDb.prepare(`UPDATE items SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params, id);
    }
    if (b.tags !== undefined) {
      theDb.prepare('DELETE FROM item_tags WHERE item_id=?').run(id);
      for (const t of b.tags) {
        const tag = tags.create(t, { status: 'active' });
        if (tag) tags.tagItem(id, tag.id, { source: 'user' });
      }
    }
    capture.syncLinks(id);
    theStore.ftsUpdate(id);
    emit('item', { id });
    return capture.getItem(id);
  });

  app.post('/api/items/:id/restore-raw', async (req, reply) => {
    const id = Number(req.params.id);
    const it = theDb.prepare('SELECT raw FROM items WHERE id=?').get(id);
    if (!it) return reply.code(404).send({ error: 'not found' });
    theStore.snapshot(id, 'restore_raw');
    theDb.prepare("UPDATE items SET content=raw, updated_at=datetime('now') WHERE id=?").run(id);
    capture.syncLinks(id);
    theStore.ftsUpdate(id);
    emit('item', { id });
    return capture.getItem(id);
  });

  // 重新清洗：从抓取原文 + 全部图片识别文字重建正文，规则清洗后再排队 AI 排版
  app.post('/api/items/:id/reclean', async (req, reply) => {
    const id = Number(req.params.id);
    const it = theDb.prepare('SELECT * FROM items WHERE id=?').get(id);
    if (!it) return reply.code(404).send({ error: 'not found' });
    const ocr = theDb.prepare("SELECT ocr_text FROM assets WHERE item_id=? AND ocr_text!='' ORDER BY id").all(id).map(a => a.ocr_text);
    const { cleaned, removed, hashtagCandidates } = cleanText(it.raw || '');
    const ocrPart = ocr.length ? cleanText(ocr.join('\n\n')).cleaned : '';
    const content = [cleaned, ocrPart && (cleaned ? '图片内容\n\n' : '') + ocrPart].filter(Boolean).join('\n\n') || it.content;
    theStore.snapshot(id, 'reclean');
    const notes = JSON.parse(it.ai_notes || '{}');
    delete notes.llm; delete notes.llm_removed;
    Object.assign(notes, { removed, hashtagCandidates });
    theDb.prepare("UPDATE items SET content=?, ai_notes=?, updated_at=datetime('now') WHERE id=?").run(content, JSON.stringify(notes), id);
    theStore.ftsUpdate(id);
    runner.enqueue(id, 'classify');
    emit('item', { id });
    return capture.getItem(id);
  });

  app.post('/api/classify/plans', async (req) => plans.create(req.body || {}));
  app.get('/api/classify/plans/:id', async (req) => plans.view(req.params.id));
  app.patch('/api/classify/plans/:id', async (req) => plans.patch(req.params.id, req.body || {}));
  app.post('/api/classify/plans/:id/apply', async (req) => {
    const r = plans.apply(req.params.id);
    emit('items', { plan: r.id });
    return r;
  });
  app.post('/api/classify/plans/:id/undo', async (req) => {
    const r = plans.undo(req.params.id);
    emit('items', { plan: r.id });
    return r;
  });
  app.post('/api/classify/plans/:id/discard', async (req) => plans.discard(req.params.id));

  app.post('/api/items/:id/copy', async (req) => {
    const id = Number(req.params.id);
    theDb.prepare("UPDATE items SET use_count=use_count+1, updated_at=datetime('now') WHERE id=?").run(id);
    return { ok: true, use_count: theDb.prepare('SELECT use_count FROM items WHERE id=?').get(id)?.use_count || 0 };
  });

  // 批量
  app.post('/api/items/batch', async (req) => {
    const { ids = [], action, tag, status } = req.body || {};
    const undo = [];
    for (const id of ids) {
      const it = theDb.prepare('SELECT * FROM items WHERE id=?').get(id);
      if (!it) continue;
      theStore.snapshot(id, 'batch_' + action);
      undo.push({ id, status: it.status, deleted_at: it.deleted_at });
      if (action === 'tag' && tag) {
        const t = tags.create(tag, { status: 'active' });
        if (t) tags.tagItem(id, t.id, { source: 'user' });
      } else if (action === 'untag' && tag) {
        const t = tags.resolve(tag);
        if (t) tags.untagItem(id, t.id);
      } else if (action === 'status' && status) {
        theDb.prepare('UPDATE items SET status=?, deleted_at=? WHERE id=?')
          .run(status, status === 'trash' ? new Date().toISOString() : null, id);
      } else if (action === 'delete') {
        if (it.status === 'trash') theDb.prepare('DELETE FROM items WHERE id=?').run(id); // 仅回收站可永久删除
        continue;
      } else if (action === 'favorite') {
        theDb.prepare('UPDATE items SET favorite=1-favorite WHERE id=?').run(id);
      }
      theStore.ftsUpdate(id);
    }
    emit('items', { ids });
    return { ok: true, undo };
  });

  // 恢复单个
  app.post('/api/items/:id/restore', async (req) => {
    const id = Number(req.params.id);
    theDb.prepare("UPDATE items SET status='inbox', deleted_at=NULL, updated_at=datetime('now') WHERE id=?").run(id);
    theStore.ftsUpdate(id);
    return { ok: true };
  });

  // 回收站清空（二次确认参数 confirm=YES）
  app.post('/api/trash/empty', async (req, reply) => {
    if (req.body?.confirm !== 'YES') return reply.code(400).send({ error: '需要 confirm=YES' });
    const n = theDb.prepare("DELETE FROM items WHERE status='trash'").run();
    return { ok: true, deleted: n.changes };
  });

  // 版本
  app.get('/api/items/:id/versions', async (req) => {
    return theDb.prepare('SELECT id,reason,created_at,title FROM item_versions WHERE item_id=? ORDER BY id DESC LIMIT 50').all(Number(req.params.id));
  });
  app.get('/api/versions/:vid', async (req) => {
    const v = theDb.prepare('SELECT * FROM item_versions WHERE id=?').get(Number(req.params.vid));
    if (!v) return { error: 'not found' };
    const cur = theDb.prepare('SELECT title,content FROM items WHERE id=?').get(v.item_id);
    return { version: v, current: cur, diff: diffLines(JSON.parse(v.snapshot_json).content || '', cur?.content || '') };
  });
  app.post('/api/versions/:vid/restore', async (req) => {
    const v = theDb.prepare('SELECT * FROM item_versions WHERE id=?').get(Number(req.params.vid));
    if (!v) return { error: 'not found' };
    const snap = JSON.parse(v.snapshot_json);
    theStore.snapshot(v.item_id, 'pre-rollback');
    theDb.prepare(`UPDATE items SET title=?, content=?, kind=?, props_json=?, summary=?, updated_at=datetime('now') WHERE id=?`)
      .run(snap.title, snap.content, snap.kind, snap.props_json, snap.summary, v.item_id);
    capture.syncLinks(v.item_id);
    theStore.ftsUpdate(v.item_id);
    return { ok: true };
  });

  // ---------- 标签 ----------
  app.get('/api/tags', async () => {
    return { tags: tags.all(), pending: tags.pending() };
  });
  app.post('/api/tags', async (req) => {
    const { name, color, description } = req.body || {};
    const t = tags.create(name, { status: 'active', color, description });
    return t || { error: 'invalid name' };
  });
  app.post('/api/tags/:id/approve', async (req) => { tags.approve(Number(req.params.id)); return { ok: true }; });
  app.post('/api/tags/:id/reject', async (req) => { tags.reject(Number(req.params.id)); return { ok: true }; });
  app.post('/api/tags/merge', async (req) => {
    const { from, to } = req.body || {};
    const fromId = typeof from === 'number' ? from : tags.resolve(from)?.id;
    const toId = typeof to === 'number' ? to : tags.create(to, { status: 'active' })?.id;
    if (!fromId || !toId) return { error: 'tag not found' };
    tags.merge(fromId, toId);
    return { ok: true };
  });
  app.patch('/api/tags/:id', async (req) => {
    const id = Number(req.params.id);
    const { name, color, description } = req.body || {};
    if (name) {
      const n = normalizeTag(name);
      const conflict = tags.getByName(n);
      if (conflict && conflict.id !== id) return { error: '已存在同名标签' };
      theDb.prepare('UPDATE tags SET name=? WHERE id=?').run(n, id);
    }
    if (color !== undefined) theDb.prepare('UPDATE tags SET color=? WHERE id=?').run(color, id);
    if (description !== undefined) theDb.prepare('UPDATE tags SET description=? WHERE id=?').run(description, id);
    return { ok: true };
  });

  // ---------- 集合 ----------
  app.get('/api/collections', async () => {
    const cols = theDb.prepare('SELECT c.*, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id=c.id) count FROM collections c ORDER BY c.name').all();
    return cols;
  });
  app.post('/api/collections', async (req) => {
    const { name, parent_id, description, cover } = req.body || {};
    if (!name?.trim()) return { error: 'name required' };
    const r = theDb.prepare('INSERT INTO collections(name,parent_id,description,cover) VALUES(?,?,?,?)').run(name.trim(), parent_id || null, description || '', cover || '');
    return { id: r.lastInsertRowid };
  });
  app.patch('/api/collections/:id', async (req) => {
    const { name, parent_id, description, cover } = req.body || {};
    const id = Number(req.params.id);
    if (name !== undefined) theDb.prepare('UPDATE collections SET name=? WHERE id=?').run(name, id);
    if (parent_id !== undefined) theDb.prepare('UPDATE collections SET parent_id=? WHERE id=?').run(parent_id, id);
    if (description !== undefined) theDb.prepare('UPDATE collections SET description=? WHERE id=?').run(description, id);
    if (cover !== undefined) theDb.prepare('UPDATE collections SET cover=? WHERE id=?').run(cover, id);
    return { ok: true };
  });
  app.delete('/api/collections/:id', async (req) => {
    theDb.prepare('DELETE FROM collections WHERE id=?').run(Number(req.params.id));
    return { ok: true };
  });
  app.post('/api/collections/:id/items', async (req) => {
    const { item_id, add = true } = req.body || {};
    const cid = Number(req.params.id);
    if (add) theDb.prepare('INSERT OR IGNORE INTO collection_items(collection_id,item_id) VALUES(?,?)').run(cid, item_id);
    else theDb.prepare('DELETE FROM collection_items WHERE collection_id=? AND item_id=?').run(cid, item_id);
    return { ok: true };
  });
  app.get('/api/collections/:id/items', async (req) => {
    const rows = theDb.prepare('SELECT i.* FROM collection_items ci JOIN items i ON i.id=ci.item_id WHERE ci.collection_id=? ORDER BY i.updated_at DESC').all(Number(req.params.id));
    const tagMap = tagsForItems(theDb, rows.map(r => r.id));
    return rows.map(r => ({ ...r, tags: tagMap.get(r.id) || [] }));
  });

  // ---------- 导入 ----------
  app.post('/api/import/chat', async (req) => {
    const { format = 'auto', data } = req.body || {};
    let sessions = [];
    if (format === 'chatgpt' || (format === 'auto' && looksLikeChatgpt(data))) sessions = parseChatgptExport(data);
    else if (format === 'claude' || (format === 'auto' && looksLikeClaude(data))) sessions = parseClaudeExport(data);
    else sessions = parseTranscript(typeof data === 'string' ? data : JSON.stringify(data));
    const candidates = candidatesFromSessions(sessions);
    return { sessions: sessions.length, candidates };
  });

  app.post('/api/import/chat/commit', async (req) => {
    const { candidates = [], saveContext = true } = req.body || {};
    const created = [];
    for (const c of candidates) {
      const ctx = saveContext && c.context ? '\n\n<!-- context: ' + c.context.map(m => `${m.role}: ${m.text.slice(0, 200)}`).join(' | ').slice(0, 1500) + ' -->' : '';
      const r = await capture.capture({ text: c.text + ctx, title: c.title, sourceType: 'import', kindHint: 'prompt' });
      if (r.items?.length) created.push(r.items[0].id);
    }
    return { ok: true, created };
  });

  app.post('/api/import/obsidian', async (req) => {
    const { dir } = req.body || {};
    if (!dir || !fs.existsSync(dir)) return { error: '目录不存在' };
    const files = importVault(dir);
    const created = [];
    for (const f of files) {
      const r = await capture.capture({ text: f.content, title: f.title, sourceType: 'import' });
      const item = r.items?.[0];
      if (!item) continue;
      created.push(item.id);
      for (const t of f.tags) {
        const tag = tags.create(t, { status: 'active' });
        if (tag) tags.tagItem(item.id, tag.id, { source: 'user' });
      }
      theDb.prepare('UPDATE items SET props_json=? WHERE id=?')
        .run(JSON.stringify({ ...JSON.parse(item.props_json || '{}'), obsidian_path: f.path }), item.id);
    }
    // 双链
    for (const id of created) capture.syncLinks(id);
    return { ok: true, imported: created.length };
  });

  // ---------- 导出 ----------
  app.get('/api/export/json', async (req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="catch-export.json"');
    return exportJson(theStore);
  });
  app.post('/api/import/json', async (req) => {
    const n = importJson(theStore, req.body);
    return { ok: true, imported: n };
  });
  app.get('/api/export/obsidian', async (req, reply) => {
    const dir = theStore.settings.get('obsidian_vault');
    const onlyCurated = req.query.curated === '1';
    const zip = req.query.zip === '1';
    if (dir && !zip) {
      const entries = exportToObsidian(theStore, { onlyCurated, outDir: dir });
      return { ok: true, count: entries.length, dir };
    }
    const entries = exportToObsidian(theStore, { onlyCurated });
    const buf = makeZip(entries);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="catch-obsidian.zip"');
    return reply.send(buf);
  });
  app.get('/api/export/prompts.md', async (req, reply) => {
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="prompts.md"');
    return promptsToMarkdown(theStore);
  });
  app.get('/api/items/:id/export-skill', async (req, reply) => {
    const it = theDb.prepare('SELECT * FROM items WHERE id=?').get(Number(req.params.id));
    if (!it) return reply.code(404).send({ error: 'not found' });
    const files = theDb.prepare('SELECT path,content FROM item_files WHERE item_id=?').all(it.id);
    const name = sanitizeName(it.title || 'skill');
    const skillMd = files.find(f => f.path === 'SKILL.md')?.content
      || buildSkillMd({ name, description: it.summary || it.title || 'A captured skill', body: it.content });
    const entries = [{ name: `${name}/SKILL.md`, data: skillMd }];
    for (const f of files) {
      if (f.path !== 'SKILL.md') entries.push({ name: `${name}/${f.path.replace(/\.\./g, '')}`, data: f.content });
    }
    const buf = makeZip(entries);
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${name}.zip"`);
    return reply.send(buf);
  });

  // ---------- skill ----------
  app.post('/api/skill/validate', async (req) => {
    const { content = '' } = req.body || {};
    return validateSkill(content);
  });
  app.put('/api/items/:id/files', async (req) => {
    const id = Number(req.params.id);
    const { files = [] } = req.body || {};
    theDb.prepare('DELETE FROM item_files WHERE item_id=?').run(id);
    for (const f of files) {
      if (!f.path || /\.\./.test(f.path)) continue;
      theDb.prepare('INSERT INTO item_files(item_id,path,content) VALUES(?,?,?)').run(id, f.path, f.content || '');
    }
    return { ok: true };
  });

  // ---------- jobs ----------
  app.get('/api/jobs', async () => {
    return {
      counts: theDb.prepare('SELECT state, COUNT(*) c FROM jobs GROUP BY state').all(),
      recent: theDb.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 30').all(),
    };
  });
  app.post('/api/jobs/retry-failed', async () => {
    return { ok: true, count: runner.retryFailed() };
  });
  app.post('/api/items/:id/reclassify', async (req) => {
    const id = Number(req.params.id);
    runner.enqueue(id, 'classify');
    return { ok: true };
  });
  app.post('/api/reclassify', async (req) => {
    const onlyInbox = req.body?.inbox !== false;
    const rows = theDb.prepare(`SELECT id FROM items WHERE status ${onlyInbox ? '=' : '!='} 'inbox'`).all();
    for (const r of rows) runner.enqueue(r.id, 'classify');
    return { ok: true, count: rows.length };
  });

  // dry-run 试运行：预览 AI 结果不落库
  app.post('/api/dryrun', async (req, reply) => {
    const { item_id, text = '', instruction = '' } = req.body || {};
    let cleaned = text;
    if (item_id) {
      const it = theDb.prepare('SELECT content FROM items WHERE id=?').get(Number(item_id));
      cleaned = it?.content || '';
    }
    if (!cleaned) return reply.code(400).send({ error: '没有内容' });
    const client = llm || new LlmClient(theStore.settings, { fetchImpl });
    if (!client.available()) return reply.code(400).send({ error: '未配置 LLM，无法试运行' });
    const related = tags.suggestRelevant(cleaned, parseInt(theStore.settings.get('tag_suggest_topk')) || 30);
    const seen = new Set(related.map(t => t.id));
    for (const t of tags.frequent(40)) if (!seen.has(t.id)) { related.push(t); seen.add(t.id); }
    const { parsed } = await client.extract(cleaned, {
      relatedTags: related,
      maxTags: parseInt(theStore.settings.get('ai_tags_per_item')) || 5,
      customPrompt: instruction || theStore.settings.get('llm_custom_prompt'),
    });
    return { preview: parsed, relatedTags: related.map(t => t.name) };
  });

  // ---------- 设置 ----------
  app.get('/api/settings', async () => theStore.settings.publicView());
  app.put('/api/settings', async (req) => {
    theStore.settings.setMany(req.body || {});
    return { ok: true };
  });
  app.post('/api/settings/reset-token', async () => {
    return { token: theStore.settings.resetCaptureToken() };
  });
  app.post('/api/settings/test-llm', async (req) => {
    const client = llm || new LlmClient(theStore.settings, { fetchImpl });
    if (!client.available()) return { ok: false, error: '未配置' };
    try { return await client.test(); } catch (e) { return { ok: false, error: e.message }; }
  });
  app.post('/api/settings/test-ocr', async (req) => {
    const chain = ocr || createOcrChain(theStore.settings, { fetchImpl });
    return { results: await chain.testAll() };
  });

  // ---------- 资产 ----------
  app.get('/assets/:file', async (req, reply) => {
    const fname = path.basename(req.params.file);
    if (!/^[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(fname)) return reply.code(400).send();
    const p = path.join(ASSETS_DIR, fname);
    if (!fs.existsSync(p)) return reply.code(404).send();
    const ext = fname.split('.').pop();
    reply.header('Content-Type', `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    return reply.send(fs.readFileSync(p));
  });
  // 给已有条目加配图（辅助理解）
  app.post('/api/items/:id/assets', async (req, reply) => {
    const it = theDb.prepare('SELECT id FROM items WHERE id=?').get(Number(req.params.id));
    if (!it) return reply.code(404).send({ error: '条目不存在' });
    const added = [];
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (!part.file) continue;
        const buf = await part.toBuffer();
        if (!IMAGE_MIMES.has(part.mimetype)) continue;
        if (buf.length > MAX_IMAGE_BYTES) continue;
        const id = capture.saveAsset(it.id, { buffer: buf, mime: part.mimetype });
        if (id) added.push(id);
      }
    } else return reply.code(400).send({ error: '需要 multipart 图片' });
    if (added.length && theStore.settings.get('auto_ocr') !== '0') runner.enqueue(it.id, 'ocr');
    return { ok: true, added: added.length };
  });

  app.get('/api/assets/:id/file', async (req, reply) => {
    const a = theDb.prepare('SELECT * FROM assets WHERE id=?').get(Number(req.params.id));
    if (!a || !a.path) return reply.code(404).send();
    const p = path.join(ASSETS_DIR, path.basename(a.path));
    if (!fs.existsSync(p)) return reply.code(404).send();
    reply.header('Content-Type', a.mime || 'image/png');
    return reply.send(fs.readFileSync(p));
  });

  // ---------- SSE ----------
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    reply.raw.write('event: hi\ndata: {}\n\n');
    sseClients.add(reply);
    req.raw.on('close', () => sseClients.delete(reply));
    return reply;
  });

  // /capture 页面回退（bookmarklet fallback）：静态页
  app.get('/capture', (req, reply) => {
    reply.type('text/html');
    return `<!doctype html><meta charset="utf-8"><title>保存到 Catch</title><style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px}</style><h1>保存到 Catch</h1><form method="post" action="/api/capture"><textarea name="text" rows="10" style="width:100%"></textarea><br><button style="margin-top:8px;padding:8px 16px">保存</button></form><script>const t=new URLSearchParams(location.search).get('text');if(t)document.querySelector('textarea').value=t;</script>`;
  });

  return app;
}

function tagsForItems(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT it.item_id, t.* FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id).push(r);
  }
  return map;
}

function looksLikeChatgpt(data) {
  const arr = Array.isArray(data) ? data : [data];
  return arr[0] && arr[0].mapping !== undefined;
}
function looksLikeClaude(data) {
  const arr = Array.isArray(data) ? data : [data];
  return arr[0] && arr[0].chat_messages !== undefined;
}

function splitBatch(text) {
  const parts = text.split(/^={5,}\s*$/m).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

// 简易行 diff（LCS），供版本对比
export function diffLines(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < A.length) out.push({ type: 'del', text: A[i++] });
  while (j < B.length) out.push({ type: 'add', text: B[j++] });
  return out;
}

// ---- 独立启动 ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = parseInt(process.env.PORT) || 5173;
  const app = await buildApp();
  // 预置 AI 行业常用集合（仅真实启动时；测试用 buildApp 不触发）
  if (!app.store.db.prepare('SELECT 1 FROM collections LIMIT 1').get()) {
    const seed = [
      ['写作与文案', '✍️', '各类写作、改写、润色、文案生成 prompt'],
      ['编程与代码', '💻', '代码生成、审查、重构、调试类 prompt/skill'],
      ['绘画与设计', '🎨', 'Midjourney / SD / 视觉设计类提示词'],
      ['学习与效率', '📚', '学习方法、总结、效率工具类 prompt'],
      ['产品与分析', '📊', '产品需求、数据分析、商业分析类'],
      ['翻译与润色', '🌐', '翻译、中英互译、语言润色类'],
    ];
    const ins = app.store.db.prepare('INSERT INTO collections(name,description,cover) VALUES(?,?,?)');
    for (const [n, c, d] of seed) ins.run(n, d, c);
  }
  app.runner.start();
  await app.listen({ host, port });
  console.log(`Catch 已启动: http://${host}:${port}`);
  console.log(`Capture token 见设置页 /api/settings`);
}
