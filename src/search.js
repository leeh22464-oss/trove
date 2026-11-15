// 搜索：tag:/kind:/source:/is:/status:/has: 前缀、短语、-排除、中文 trigram FTS。
import { TagService } from './tags.js';

// 把普通查询词转 trigram FTS 查询：>=3 字直接 AND 子串匹配；
// trigram 索引对任意连续 3 字做子串匹配。1-2 字退化为 LIKE（外层处理）。
function ftsTokens(term) {
  return '"' + term.replace(/"/g, '""') + '"';
}

export function parseQuery(q) {
  const out = { text: [], phrases: [], tags: [], kinds: [], sources: [], statuses: [], filters: [], neg: [] };
  const re = /(-?)(?:(\w+):)?("[^"]*"|\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    const [, neg, key, raw] = m;
    const tok = raw.replace(/^"|"$/g, '');
    const push = (arr, v, k) => (neg ? out.neg.push({ [k || key || 'text']: v }) : arr.push(v));
    if (key === 'tag') push(out.tags, tok, 'tag');
    else if (key === 'kind') push(out.kinds, tok, 'kind');
    else if (key === 'source') push(out.sources, tok, 'source');
    else if (key === 'status') push(out.statuses, tok, 'status');
    else if (key === 'is') {
      if (neg) out.neg.push({ is: tok });
      else out.filters.push({ is: tok });
    } else if (key === 'has') {
      if (neg) out.neg.push({ has: tok });
      else out.filters.push({ has: tok });
    } else if (raw.startsWith('"')) {
      if (neg) out.neg.push({ text: tok });
      else out.phrases.push(tok);
    } else {
      if (neg) out.neg.push({ text: tok });
      else out.text.push(tok);
    }
  }
  return out;
}

const LIKE_TEXT = (term) => {
  const t = `%${term.replace(/[%_]/g, c => '\\' + c)}%`;
  return "(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')";
};

export class Searcher {
  constructor(db) {
    this.db = db;
    this.tags = new TagService(db);
  }

  search(q, { status = 'active', limit = 50, offset = 0 } = {}) {
    const parsed = parseQuery(q);
    const params = [];
    const where = [];
    let join = '';

    const negConds = [];
    const negParams = [];
    for (const n of parsed.neg) {
      if (n.text) {
        const t = `%${n.text}%`;
        negConds.push("(i.title NOT LIKE ? AND i.content NOT LIKE ? AND i.summary NOT LIKE ?)");
        negParams.push(t, t, t);
      } else if (n.is === 'favorite') {
        negConds.push('i.favorite=0');
      } else if (n.has === 'image') {
        negConds.push('NOT EXISTS(SELECT 1 FROM assets a WHERE a.item_id=i.id)');
      } else if (n.kind) {
        negConds.push('i.kind != ?');
        negParams.push(n.kind);
      } else if (n.status) {
        negConds.push('i.status != ?');
        negParams.push(n.status);
      } else if (n.source) {
        negConds.push('(i.source_url NOT LIKE ? AND i.source_platform NOT LIKE ?)');
        negParams.push(`%${n.source}%`, `%${n.source}%`);
      } else if (n.tag) {
        const ids = this.tags.expandIds(n.tag);
        if (ids.length) {
          negConds.push(`NOT EXISTS(SELECT 1 FROM item_tags it WHERE it.item_id=i.id AND it.tag_id IN (${ids.map(() => '?').join(',')}))`);
          negParams.push(...ids);
        }
      }
    }

    // 状态过滤
    if (parsed.statuses.includes('trash') || status === 'trash') {
      where.push("i.status='trash'");
    } else if (status === 'all' && !parsed.statuses.length) {
      where.push("i.status!='trash'");
    } else {
      const st = parsed.statuses.length ? parsed.statuses : ['inbox', 'curated'];
      where.push(`i.status IN (${st.map(() => '?').join(',')})`);
      params.push(...st);
      where.push('i.deleted_at IS NULL');
    }

    if (parsed.kinds.length) {
      where.push(`i.kind IN (${parsed.kinds.map(() => '?').join(',')})`);
      params.push(...parsed.kinds);
    }
    for (const s of parsed.sources) {
      where.push('(i.source_platform LIKE ? OR i.source_url LIKE ?)');
      params.push(`%${s}%`, `%${s}%`);
    }
    for (const f of parsed.filters) {
      if (f.is === 'favorite') where.push('i.favorite=1');
      if (f.has === 'image') where.push('EXISTS(SELECT 1 FROM assets a WHERE a.item_id=i.id)');
    }

    // tag: 支持多个 AND + 子标签展开
    for (const tg of parsed.tags) {
      const ids = this.tags.expandIds(tg);
      if (!ids.length) {
        where.push('1=0');
      } else {
        where.push(`EXISTS(SELECT 1 FROM item_tags it WHERE it.item_id=i.id AND it.tag_id IN (${ids.map(() => '?').join(',')}))`);
        params.push(...ids);
      }
    }

    // 文本项：FTS（>=3 连续字符用 trigram）或 LIKE
    const textTerms = [...parsed.text, ...parsed.phrases];
    let ftsClause = null;
    const likeTerms = [];
    for (const t of textTerms) {
      if ([...t].length >= 3) {
        ftsClause = ftsClause ? `${ftsClause} AND ${ftsTokens(t)}` : ftsTokens(t);
      } else {
        likeTerms.push(t);
      }
    }
    if (ftsClause) {
      where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)');
      params.push(ftsClause);
    }
    for (const t of likeTerms) {
      where.push(LIKE_TEXT(t));
      const tt = `%${t}%`;
      params.push(tt, tt, tt);
    }

    where.push(...negConds);
    params.push(...negParams);
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const sql = `SELECT i.* FROM items i ${join} ${whereSql} ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params);

    const countSql = `SELECT COUNT(*) c FROM items i ${join} ${whereSql}`;
    const countParams = params.slice(0, params.length - 2);
    const total = this.db.prepare(countSql).get(...countParams).c;

    return { rows, total, parsed };
  }

  related(itemId, limit = 8) {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
    if (!item) return [];
    const tagRows = this.db.prepare('SELECT tag_id FROM item_tags WHERE item_id=?').all(itemId);
    const results = new Map();
    if (tagRows.length) {
      const q = `SELECT it.item_id id, COUNT(*) shared, i.title, i.kind FROM item_tags it JOIN items i ON i.id=it.item_id WHERE it.tag_id IN (${tagRows.map(() => '?').join(',')}) AND it.item_id!=? AND i.status!='trash' GROUP BY it.item_id ORDER BY shared DESC LIMIT ?`;
      for (const r of this.db.prepare(q).all(...tagRows.map(t => t.tag_id), itemId, limit)) {
        results.set(r.id, { id: r.id, title: r.title, kind: r.kind, via: 'tags', shared: r.shared });
      }
    }
    // 反链
    const backlinks = this.db.prepare('SELECT l.src_id id, i.title, i.kind FROM links l JOIN items i ON i.id=l.src_id WHERE l.dst_id=?').all(itemId);
    return { related: [...results.values()], backlinks };
  }
}
