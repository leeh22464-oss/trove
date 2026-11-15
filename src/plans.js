// 分类方案：AI 出方案 → 用户确认/修改 → 一键应用 / 撤销。生成方案时不写任何标签数据。
import { TagService, normalizeTag, heuristicTags } from './tags.js';

const MAX_ITEMS = 50;
const CONCURRENCY = 3;

export class PlanError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

export class PlanService {
  constructor(store, { llm = null } = {}) {
    this.store = store;
    this.db = store.db;
    this.llm = llm;
    this.tags = new TagService(this.db);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM plans WHERE id=?').get(Number(id));
    if (!row) throw new PlanError('方案不存在', 404);
    return { ...row, plan: JSON.parse(row.plan_json), undo: JSON.parse(row.undo_json) };
  }

  view(id) {
    const p = this.get(id);
    return { id: p.id, state: p.state, scope: p.scope, plan: p.plan, created_at: p.created_at, updated_at: p.updated_at };
  }

  save(id, plan, state) {
    this.db.prepare("UPDATE plans SET plan_json=?, state=COALESCE(?,state), updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(plan), state || null, id);
  }

  async create({ scope = 'inbox', ids = [] } = {}) {
    let rows;
    if (scope === 'ids') {
      if (!ids.length) throw new PlanError('ids 不能为空');
      rows = ids.map(i => this.db.prepare("SELECT * FROM items WHERE id=? AND status!='trash'").get(Number(i))).filter(Boolean);
    } else {
      rows = this.db.prepare("SELECT * FROM items WHERE status='inbox' ORDER BY id").all();
    }
    const truncated = rows.length > MAX_ITEMS;
    rows = rows.slice(0, MAX_ITEMS);

    const items = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        items[i] = await this.suggestFor(rows[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

    const plan = { items, merges: this.suggestMerges(items), ...(truncated ? { truncated: true } : {}) };
    this.refreshNewTags(plan);
    const r = this.db.prepare('INSERT INTO plans(scope, plan_json) VALUES(?,?)').run(scope, JSON.stringify(plan));
    return this.view(r.lastInsertRowid);
  }

  async suggestFor(item) {
    const base = { item_id: item.id, title: item.title, kind: item.kind, add_tags: [], new_tags: [], collection: null, exclude: false };
    try {
      const notes = JSON.parse(item.ai_notes || '{}');
      let suggested = notes.suggested_tags;
      let collection = null;
      if (!Array.isArray(suggested) || !suggested.length) {
        if (this.llm?.available()) {
          const settings = this.store.settings;
          // 相似 top-K + 全库高频 top-N 去重，让 LLM 优先复用已有标签，避免每条造新标签
          const topk = parseInt(settings.get('tag_suggest_topk')) || 30;
          const related = this.tags.suggestRelevant(item.content || '', topk);
          const seen = new Set(related.map(t => t.id));
          for (const t of this.tags.frequent(40)) if (!seen.has(t.id)) { related.push(t); seen.add(t.id); }
          const { parsed } = await this.llm.extract(item.content || '', {
            relatedTags: related,
            maxTags: parseInt(settings.get('ai_tags_per_item')) || 5,
            customPrompt: settings.get('llm_custom_prompt'),
          });
          suggested = parsed?.tags || [];
          collection = parsed?.collection_hint || null;
        } else {
          suggested = heuristicTags(item.content || '', notes.hashtagCandidates || []);
        }
      }
      const props = JSON.parse(item.props_json || '{}');
      collection = collection || props.collection_hint || null;
      base.add_tags = this.cleanTags(suggested);
      base.collection = collection ? String(collection).trim().slice(0, 60) || null : null;
    } catch (e) {
      base.error = String(e.message || e).slice(0, 200);
    }
    return base;
  }

  cleanTags(list) {
    const out = [];
    for (const t of list || []) {
      const resolved = this.tags.resolve(t);
      const name = resolved ? resolved.name : normalizeTag(t);
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }

  refreshNewTags(plan) {
    for (const it of plan.items) it.new_tags = it.add_tags.filter(t => !this.tags.resolve(t));
  }

  suggestMerges(items) {
    const names = new Set(items.flatMap(i => i.add_tags));
    const merges = [];
    for (const n of names) {
      if (this.tags.getByName(n)) continue;
      const near = this.tags.suggestRelevant(n, 1)[0];
      if (near && near.name !== n && (near.name.includes(n) || n.includes(near.name))) merges.push({ from: n, to: near.name });
    }
    return merges;
  }

  patch(id, { items, merges }) {
    const p = this.get(id);
    if (p.state !== 'draft') throw new PlanError('只有草稿方案可以修改', 409);
    const plan = p.plan;
    for (const o of items || []) {
      const it = plan.items.find(x => x.item_id === o.item_id);
      if (!it) continue;
      if (o.add_tags !== undefined) it.add_tags = this.cleanTags(o.add_tags);
      if (o.collection !== undefined) it.collection = o.collection ? String(o.collection).trim().slice(0, 60) || null : null;
      if (o.exclude !== undefined) it.exclude = !!o.exclude;
    }
    if (merges !== undefined) plan.merges = merges.map(m => ({ from: normalizeTag(m.from), to: normalizeTag(m.to) })).filter(m => m.from && m.to && m.from !== m.to);
    this.refreshNewTags(plan);
    this.save(p.id, plan);
    return this.view(p.id);
  }

  apply(id, { failAfter = null } = {}) {
    const p = this.get(id);
    if (p.state === 'applied') throw new PlanError('方案已应用', 409);
    if (p.state !== 'draft') throw new PlanError('方案状态不允许应用', 409);
    const db = this.db;
    const undo = { items: [], new_tag_ids: [], new_collection_ids: [], merges: [] };
    db.exec('BEGIN');
    try {
      const tagIdOf = (name) => {
        let t = this.tags.resolve(name);
        if (!t) { t = this.tags.create(name, { status: 'active' }); undo.new_tag_ids.push(t.id); }
        return t.id;
      };
      for (const it of p.plan.items) {
        if (it.exclude) continue;
        if (!db.prepare('SELECT 1 FROM items WHERE id=?').get(it.item_id)) continue;
        this.store.snapshot(it.item_id, 'plan_apply');
        const prevTags = db.prepare('SELECT tag_id, source, confidence FROM item_tags WHERE item_id=?').all(it.item_id);
        const prevCols = db.prepare('SELECT collection_id FROM collection_items WHERE item_id=?').all(it.item_id).map(r => r.collection_id);
        undo.items.push({ item_id: it.item_id, tags: prevTags, collections: prevCols });
        for (const name of it.add_tags) this.tags.tagItem(it.item_id, tagIdOf(name), { source: 'ai', confidence: 0.7 });
        if (it.collection) {
          let c = db.prepare('SELECT id FROM collections WHERE name=?').get(it.collection);
          if (!c) {
            const r = db.prepare('INSERT INTO collections(name) VALUES(?)').run(it.collection);
            c = { id: Number(r.lastInsertRowid) };
            undo.new_collection_ids.push(c.id);
          }
          db.prepare('INSERT INTO collection_items(collection_id,item_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(c.id, it.item_id);
        }
        if (failAfter !== null && undo.items.length > failAfter) throw new Error('injected failure');
      }
      for (const m of p.plan.merges) {
        const from = this.tags.resolve(m.from), to = this.tags.resolve(m.to);
        if (!from || !to || from.id === to.id) continue;
        undo.merges.push({ from: m.from, to: m.to });
        this.tags.merge(from.id, to.id);
      }
      db.prepare("UPDATE plans SET state='applied', undo_json=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(undo), p.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const u of undo.items) this.store.ftsUpdate(u.item_id);
    return { ...this.view(p.id), merges_applied: undo.merges.length };
  }

  undo(id) {
    const p = this.get(id);
    if (p.state !== 'applied') throw new PlanError('只有已应用的方案可以撤销', 409);
    const db = this.db;
    const u = p.undo;
    db.exec('BEGIN');
    try {
      for (const it of u.items) {
        db.prepare('DELETE FROM item_tags WHERE item_id=?').run(it.item_id);
        for (const t of it.tags) {
          if (db.prepare('SELECT 1 FROM tags WHERE id=?').get(t.tag_id)) {
            db.prepare('INSERT INTO item_tags(item_id,tag_id,source,confidence) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(it.item_id, t.tag_id, t.source, t.confidence);
          }
        }
        db.prepare('DELETE FROM collection_items WHERE item_id=?').run(it.item_id);
        for (const cid of it.collections) {
          if (db.prepare('SELECT 1 FROM collections WHERE id=?').get(cid)) {
            db.prepare('INSERT INTO collection_items(collection_id,item_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(cid, it.item_id);
          }
        }
      }
      for (const id of u.new_tag_ids) {
        db.prepare('DELETE FROM item_tags WHERE tag_id=?').run(id);
        db.prepare('DELETE FROM tags WHERE id=?').run(id);
      }
      for (const id of u.new_collection_ids) db.prepare('DELETE FROM collections WHERE id=?').run(id);
      db.prepare("UPDATE plans SET state='undone', updated_at=datetime('now') WHERE id=?").run(p.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const it of u.items) this.store.ftsUpdate(it.item_id);
    return { ...this.view(p.id), merge_reverted: u.merges.length === 0 };
  }

  discard(id) {
    const p = this.get(id);
    if (p.state !== 'draft') throw new PlanError('只有草稿方案可以丢弃', 409);
    this.save(p.id, p.plan, 'discarded');
    return this.view(p.id);
  }
}
