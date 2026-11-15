// 后台任务队列：clean / classify / ocr。失败指数退避，最多 5 次。
// LLM / OCR 可注入，单个 job 异常不会挂死 runner。
import { LlmClient, applyExtraction } from './llm.js';
import { createOcrChain } from './ocr/index.js';
import { prepareImage, mergeSliceTexts, getMeta } from './ocr/preprocess.js';
import { TagService, heuristicTags } from './tags.js';
import { cleanText } from './clean.js';
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from './config.js';

const MAX_ATTEMPTS = 5;
const backoff = (attempt) => Math.min(300, Math.pow(2, attempt) * 5); // 秒

export class JobRunner {
  constructor(store, { llm = null, ocr = null, emit = () => {} } = {}) {
    this.store = store;
    this.db = store.db;
    this.tags = new TagService(this.db);
    this.llm = llm || new LlmClient(store.settings);
    this.ocr = ocr || createOcrChain(store.settings);
    this.emit = emit;
    this.timer = null;
    this.running = false;
  }

  enqueue(itemId, type, payload = {}) {
    this.db.prepare('INSERT INTO jobs(item_id,type,payload_json) VALUES(?,?,?)')
      .run(itemId, type, JSON.stringify(payload));
    this.setProcessing(itemId);
  }

  setProcessing(itemId) {
    const rows = this.db.prepare("SELECT type FROM jobs WHERE item_id=? AND state IN ('pending','running')").all(itemId);
    this.db.prepare('UPDATE items SET processing=? WHERE id=?').run(rows.map(r => r.type).join(','), itemId);
    this.emit('item', { id: itemId });
  }

  retryFailed() {
    const n = this.db.prepare("UPDATE jobs SET state='pending', attempts=0, next_run_at=datetime('now'), last_error='' WHERE state='failed'").run();
    for (const j of this.db.prepare('SELECT item_id FROM jobs WHERE state=?').all('pending')) this.setProcessing(j.item_id);
    return n.changes;
  }

  // 供测试和定时器共用：跑掉所有当前到期的 pending job，返回处理数
  async runPending() {
    let done = 0;
    for (;;) {
      const job = this.db.prepare(
        "SELECT * FROM jobs WHERE state='pending' AND next_run_at<=datetime('now') ORDER BY id LIMIT 1"
      ).get();
      if (!job) break;
      await this.runOne(job);
      done++;
    }
    return done;
  }

  async runOne(job) {
    this.db.prepare("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=datetime('now') WHERE id=?").run(job.id);
    try {
      if (job.type === 'classify' || job.type === 'clean') await this.doClassify(job);
      else if (job.type === 'ocr') await this.doOcr(job);
      else throw new Error(`未知 job 类型 ${job.type}`);
      this.db.prepare("UPDATE jobs SET state='done', updated_at=datetime('now') WHERE id=?").run(job.id);
    } catch (e) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const next = `+${backoff(attempts)} seconds`;
      this.db.prepare(`UPDATE jobs SET state=?, last_error=?, next_run_at=datetime('now', ?), updated_at=datetime('now') WHERE id=?`)
        .run(failed ? 'failed' : 'pending', String(e.message || e).slice(0, 500), next, job.id);
    } finally {
      if (job.item_id) this.setProcessing(job.item_id);
      this.emit('jobs', { id: job.id, type: job.type });
    }
  }

  // classify：LLM 抽取（配置了才用），否则启发式兜底
  async doClassify(job) {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(job.item_id);
    if (!item || item.status === 'trash') return;
    const cleaned = item.content || '';
    if (!cleaned.trim()) return;

    this.store.snapshot(item.id, 'classify');
    const settings = this.store.settings;
    const maxTags = parseInt(settings.get('ai_tags_per_item')) || 5;

    if (this.llm.available()) {
      const related = this.tags.suggestRelevant(cleaned, parseInt(settings.get('tag_suggest_topk')) || 30);
      const seen = new Set(related.map(t => t.id));
      for (const t of this.tags.frequent(40)) if (!seen.has(t.id)) { related.push(t); seen.add(t.id); }
      const { parsed, truncated } = await this.llm.extract(cleaned, {
        relatedTags: related,
        maxTags,
        customPrompt: settings.get('llm_custom_prompt'),
      });
      const ap = applyExtraction(parsed, cleaned);
      const notes = JSON.parse(item.ai_notes || '{}');
      if (ap.aiNotes) notes.llm = ap.aiNotes;
      if (ap.removed_notes) notes.llm_removed = ap.removed_notes;
      if (truncated) notes.truncated = true;
      notes.suggested_tags = ap.tags.slice(0, maxTags);
      const props = JSON.parse(item.props_json || '{}');
      let content = ap.content;
      const esc = (s) => s.replaceAll('[', '\\[').replaceAll(']', '\\]');
      if (ap.kind === 'resource' && ap.resource_items?.length) {
        props.resource_name = ap.resource_name;
        props.resource_type = ap.resource_type;
        props.resource_url = ap.resource_url;
        props.resource_items = ap.resource_items;
        // 置顶可点击资源清单；正文里已有该链接的不再重复。低置信度(0.5–0.7)标「待确认」
        const linked = ap.resource_items.filter((r) => r.url);
        if (linked.length) {
          const lines = linked
            .filter((r) => !content.includes(`](${r.url})`) && !content.includes(`](<${r.url}>)`))
            .map((r) => `- [${esc(r.name)}](<${r.url}>)${r.unsure ? '（待确认）' : ''}`);
          if (lines.length) content = lines.join('\n') + '\n\n' + content;
        }
      } else {
        delete props.resource_name; delete props.resource_type; delete props.resource_url; delete props.resource_items;
      }
      this.db.prepare(`UPDATE items SET kind=?, title=COALESCE(NULLIF(?,''),title), content=?, summary=?, lang=COALESCE(NULLIF(?,''),lang), ai_notes=?, updated_at=datetime('now') WHERE id=?`)
        .run(ap.kind, props.title_locked ? '' : ap.title, content, ap.summary, ap.lang, JSON.stringify(notes), item.id);
      if (ap.variables.length) props.variables = ap.variables;
      if (ap.target_models.length) props.target_models = ap.target_models;
      if (ap.collection_hint) props.collection_hint = ap.collection_hint;
      if (ap.is_prompt_confidence) props.prompt_confidence = ap.is_prompt_confidence;
      this.db.prepare('UPDATE items SET props_json=? WHERE id=?').run(JSON.stringify(props), item.id);
    } else if (settings.get('auto_classify') !== '0') {
      const notes = JSON.parse(item.ai_notes || '{}');
      const tagsToAdd = heuristicTags(cleaned, notes.hashtagCandidates || []);
      const title = this.db.prepare('SELECT title FROM items WHERE id=?').get(item.id).title;
      if ((!title || title === '(未命名)') && !JSON.parse(item.props_json || '{}').title_locked) {
        this.db.prepare('UPDATE items SET title=? WHERE id=?')
          .run(cleaned.split('\n').find(l => l.trim())?.slice(0, 60) || '(未命名)', item.id);
      }
      const kind = /你是|扮演|act as|role.?play|提示词|prompt/i.test(cleaned) ? 'prompt' : 'unknown';
      this.db.prepare("UPDATE items SET kind=CASE WHEN kind=? THEN ? ELSE kind END, updated_at=datetime('now') WHERE id=?")
        .run('unknown', kind, item.id);
      notes.suggested_tags = tagsToAdd.slice(0, maxTags);
      this.db.prepare('UPDATE items SET ai_notes=? WHERE id=?').run(JSON.stringify(notes), item.id);
    }
    this.store.ftsUpdate(item.id);
    this.store.touch(item.id);
    this.emit('item', { id: item.id });
  }

  // ocr：长图切片 → provider 链 → 文本并入条目
  async doOcr(job) {
    const assets = this.db.prepare("SELECT * FROM assets WHERE item_id=? AND ocr_state IN ('pending','failed')").all(job.item_id);
    // 全 duplicate（重复图，ocr_text 已复制）也要把文字并进 content；否则没 pending/failed 直接返回
    const dupWithText = this.db.prepare("SELECT id FROM assets WHERE item_id=? AND ocr_state='duplicate' AND ocr_text!=''").all(job.item_id).length;
    if (!assets.length && !dupWithText) return;
    const doneIds = [];
    let lastErr = null;
    const one = async (asset) => {
      if (!asset.path) { this.db.prepare("UPDATE assets SET ocr_state='skipped' WHERE id=?").run(asset.id); return; }
      let buffer;
      try { buffer = fs.readFileSync(path.join(ASSETS_DIR, asset.path)); } catch {
        this.db.prepare("UPDATE assets SET ocr_state='failed' WHERE id=?").run(asset.id);
        return;
      }
      try {
        const slices = await prepareImage(buffer, asset.mime);
        const texts = [];
        let visionDesc = '';
        for (const s of slices) {
          const r = await this.ocr.extract(s.buffer, asset.mime);
          texts.push(r.text || '');
          if (r.vision_desc) visionDesc = r.vision_desc;
        }
        this.db.prepare("UPDATE assets SET ocr_text=?, ocr_provider='ok', ocr_state='done', vision_desc=? WHERE id=?")
          .run(mergeSliceTexts(texts), visionDesc, asset.id);
        doneIds.push(asset.id);
      } catch (e) {
        // 单张失败只标记该图，不拖垮整组；全部失败才让 job 重试
        this.db.prepare('UPDATE assets SET ocr_state=? WHERE id=?').run(this.ocr.anyAvailable() ? 'failed' : 'skipped', asset.id);
        if (this.ocr.anyAvailable()) lastErr = e;
      }
    };
    // 多图并发识别（有上限，避免触发服务商限流）
    const limit = Math.max(1, parseInt(this.store.settings.get('ocr_concurrency')) || 4);
    const queue = [...assets];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await one(queue.shift());
    }));
    if (lastErr && !doneIds.length && !dupWithText) throw lastErr;
    // 首次识别合并全部图片文字；之后（追加图片）只合并本次新识别的，避免旧文字重复并入
    const firstRun = !this.db.prepare("SELECT 1 FROM jobs WHERE item_id=? AND type='ocr' AND state='done' AND id!=?").get(job.item_id, job.id);
    if (doneIds.length || (dupWithText && firstRun)) {
      const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(job.item_id);
      const texts = this.db.prepare(`SELECT ocr_text FROM assets WHERE item_id=? AND ocr_text!='' AND (? OR id IN (${doneIds.map(() => '?').join(',') || 'NULL'})) ORDER BY id`)
        .all(job.item_id, firstRun ? 1 : 0, ...doneIds);
      if (texts.length && item) {
        const section = texts.map((t) => t.ocr_text).join('\n\n');
        const { cleaned } = cleanText(section);
        // 不硬编码 markdown 分隔符/标题，避免详情页渲染出 --- 和 ##
        const base = item.content ? item.content + '\n\n' : '';
        const newContent = base + '图片内容\n\n' + cleaned;
        this.db.prepare("UPDATE items SET content=?, updated_at=datetime('now') WHERE id=?").run(newContent, item.id);
        this.store.ftsUpdate(item.id);
        // OCR 文本已并入 content，重跑一次 classify 让 LLM 排版（仅配置了 LLM 时）
        if (this.llm.available() && this.store.settings.get('auto_classify') !== '0') {
          this.db.prepare('INSERT INTO jobs(item_id,type,payload_json) VALUES(?,?,?)').run(item.id, 'classify', '{}');
          this.setProcessing(item.id);
        }
      }
    }
    this.emit('item', { id: job.item_id });
  }

  start(intervalMs = 1500) {
    if (this.timer) return;
    // 上次进程退出时卡在 running 的任务，启动时放回队列（否则永远不会再跑）
    const stale = this.db.prepare("UPDATE jobs SET state='pending', next_run_at=datetime('now') WHERE state='running'").run();
    if (stale.changes) for (const j of this.db.prepare("SELECT DISTINCT item_id FROM jobs WHERE state='pending'").all()) this.setProcessing(j.item_id);
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runPending().catch(() => {}).finally(() => { this.running = false; });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
