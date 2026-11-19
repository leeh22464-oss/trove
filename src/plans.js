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
          const collections = this.db.prepare('SELECT id,name,parent_id FROM collections').all();
          const { parsed } = await this.llm.extract(item.content || '', {
            relatedTags: related,
            maxTags: parseInt(settings.get('ai_tags_per_item')) || 5,
            customPrompt: settings.get('llm_custom_prompt'),
            collections,
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
      base.collection = collection ? String(collection).trim().slice(0, 80) || null : null;
    } catch (e) {
      base.error = String(e.message || e).slice(0, 200);
    }
    return base;
  }

  // 按 "父/子/孙" 路径逐级 find-or-create 集合，返回叶子 id；undo 记录新建的集合
  ensureCollectionPath(path, undo) {
    const parts = String(path || '').split('/').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    if (!parts.length) return null;
    let parentId = null;
    for (const name of parts) {
      // 每一级：先在同级里找近似匹配（同义/包含），命中就复用，否则才新建
      let c = this.matchSibling(name, parentId);
      if (!c) {
        const r = this.db.prepare('INSERT INTO collections(name,parent_id) VALUES(?,?)').run(name, parentId);
        c = { id: Number(r.lastInsertRowid) };
        undo.new_collection_ids.push(c.id);
      }
      parentId = c.id;
    }
    return parentId;
  }

  // 同级近似匹配：parentId 下找与新名"指的同一类"的集合；顶级额外走主题别名
  matchSibling(name, parentId) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\/·\-_（）()]+/g, '');
    const n = norm(name);
    if (!n) return null;
    const sibs = this.db.prepare('SELECT id,name FROM collections WHERE parent_id IS ?').all(parentId);
    // 核心词：去掉 AI/智能/库/清单 等修饰，比 "工程实践" 而非 "AI工程化实践"
    const STOP_HEAD = /^(ai|人工智能|智能|好用|常用|相关)/i;
    const STOP_TAIL = /(库|清单|列表|集|大全|合集|方法|笔记|经验|资源|实践|技能|技巧|专题)$/i;
    const core = (s) => norm(s).replace(STOP_HEAD, '').replace(STOP_TAIL, '');
    const cn = core(name);
    for (const t of sibs) {
      const tn = norm(t.name), tc = core(t.name);
      if (!tn) continue;
      if (tn === n || tn.includes(n) || n.includes(tn)) return t;
      if (cn && tc && (tc === cn || tc.includes(cn) || cn.includes(tc))) return t;
    }
    // 仅顶级：主题别名映射（面试技巧→求职、前端开发→工具）
    if (parentId == null) {
      const ALIAS = [
        [/面试|求职|简历|找工作|校招|秋招|offer/i, '求职'],
        [/提示词|prompt|咒语|大模型|llm|agent|vibe|人工智能|ai/i, 'AI'],
        [/工具|网站|app|软件|插件|组件库|平台|前端|后端|开发|编程|代码/i, '工具'],
        [/设计|ui|视觉|情绪板|排版|审美|图标|配色/i, '设计'],
        [/学习|教程|课程|成长|笔记|方法/i, '学习成长'],
      ];
      for (const [re, key] of ALIAS) {
        if (re.test(n)) {
          const hit = sibs.find((t) => norm(t.name).includes(norm(key)));
          if (hit) return hit;
        }
      }
    }
    return null;
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
          // collection 可能是层级路径 "父/子/孙"，逐级 find-or-create，挂到叶子
          const leaf = this.ensureCollectionPath(it.collection, undo);
          if (leaf) db.prepare('INSERT INTO collection_items(collection_id,item_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(leaf, it.item_id);
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
