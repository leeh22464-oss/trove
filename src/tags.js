// 标签治理：规范化、嵌套、alias 合并、pending 审批、相关标签检索。

export function normalizeTag(raw) {
  if (!raw) return '';
  let t = String(raw).trim().toLowerCase()
    .replace(/^#+|#+$/g, '')
    .replace(/＃/g, '#')
    .replace(/[\\_]+/g, '/')
    .replace(/[.,;:!?，。；：！？()[\]{}'"「」【】<>《》]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const parts = t.split('/').filter(Boolean).slice(0, 3);
  t = parts.join('/').slice(0, 60);
  return t;
}

function tagNgrams(name) {
  const g = new Set();
  const s = ' ' + name + ' ';
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  for (const seg of name.split('/')) {
    if (seg) g.add(seg);
  }
  return g;
}

export class TagService {
  constructor(db) { this.db = db; }

  getByName(name) {
    return this.db.prepare('SELECT * FROM tags WHERE name=?').get(name);
  }

  // 解析输入：先精确命中 name，再命中 aliases
  resolve(rawName) {
    const name = normalizeTag(rawName);
    if (!name) return null;
    const direct = this.getByName(name);
    if (direct) return direct;
    for (const row of this.db.prepare('SELECT * FROM tags').all()) {
      const aliases = JSON.parse(row.aliases_json || '[]');
      if (aliases.includes(name)) return row;
    }
    return null;
  }

  create(name, { status = 'active', color = '', description = '' } = {}) {
    const n = normalizeTag(name);
    if (!n) return null;
    const existing = this.resolve(n);
    if (existing) return existing;
    const r = this.db.prepare('INSERT INTO tags(name,color,description,status) VALUES(?,?,?,?)')
      .run(n, color, description, status);
    return this.db.prepare('SELECT * FROM tags WHERE id=?').get(r.lastInsertRowid);
  }

  tagItem(itemId, tagId, { source = 'user', confidence = 1 } = {}) {
    this.db.prepare('INSERT INTO item_tags(item_id,tag_id,source,confidence) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
      .run(itemId, tagId, source, confidence);
  }

  untagItem(itemId, tagId) {
    this.db.prepare('DELETE FROM item_tags WHERE item_id=? AND tag_id=?').run(itemId, tagId);
  }

  tagsOfItem(itemId) {
    return this.db.prepare('SELECT t.*, it.source, it.confidence FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=? ORDER BY t.name').all(itemId);
  }

  all() {
    return this.db.prepare('SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) count FROM tags t ORDER BY t.name').all();
  }

  pending() {
    return this.db.prepare('SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) count FROM tags t WHERE t.status=? ORDER BY count DESC').all('pending');
  }

  approve(tagId) {
    this.db.prepare("UPDATE tags SET status='active' WHERE id=?").run(tagId);
  }

  reject(tagId) {
    this.db.prepare('DELETE FROM item_tags WHERE tag_id=?').run(tagId);
    this.db.prepare('DELETE FROM tags WHERE id=?').run(tagId);
  }

  // 把 fromId 合并进 toId：条目关联迁移并去重，fromId 的名字成为 toId 的 alias
  merge(fromId, toId) {
    if (fromId === toId) return;
    const from = this.db.prepare('SELECT * FROM tags WHERE id=?').get(fromId);
    const to = this.db.prepare('SELECT * FROM tags WHERE id=?').get(toId);
    if (!from || !to) return;
    const itemIds = this.db.prepare('SELECT item_id, source, confidence FROM item_tags WHERE tag_id=?').all(fromId);
    const tx = this.db.prepare('INSERT INTO item_tags(item_id,tag_id,source,confidence) VALUES(?,?,?,?) ON CONFLICT DO NOTHING');
    for (const r of itemIds) tx.run(r.item_id, toId, r.source, r.confidence);
    this.db.prepare('DELETE FROM item_tags WHERE tag_id=?').run(fromId);
    const aliases = new Set(JSON.parse(to.aliases_json || '[]'));
    aliases.add(from.name);
    for (const a of JSON.parse(from.aliases_json || '[]')) aliases.add(a);
    aliases.delete(to.name);
    this.db.prepare('UPDATE tags SET aliases_json=? WHERE id=?').run(JSON.stringify([...aliases]), toId);
    this.db.prepare('DELETE FROM tags WHERE id=?').run(fromId);
  }

  // 子标签展开：name 或 name/ 前缀 + alias 命中
  expandIds(rawName) {
    const tag = this.resolve(rawName);
    if (!tag) return [];
    const rows = this.db.prepare('SELECT id, name FROM tags WHERE name=? OR name LIKE ?').all(tag.name, tag.name + '/%');
    return rows.map(r => r.id);
  }

  // 高频已有标签 top-N：给 LLM 的"优先复用"池，防止每条各造新标签
  frequent(k = 40) {
    return this.db.prepare('SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) count FROM tags t WHERE t.status=? ORDER BY count DESC, t.name LIMIT ?').all('active', k);
  }

  // 相关标签检索（给 LLM 的 top-K）：n-gram 相似度 + 使用次数
  suggestRelevant(text, k = 30) {
    const all = this.db.prepare('SELECT t.*, (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id=t.id) count FROM tags t WHERE t.status=?').all('active');
    if (!all.length) return [];
    const sample = String(text || '').toLowerCase().slice(0, 4000);
    const sampleG = tagNgrams(sample);
    const scored = all.map(t => {
      const names = [t.name, ...JSON.parse(t.aliases_json || '[]')];
      let score = 0;
      for (const n of names) {
        const g = tagNgrams(n);
        let hit = 0;
        for (const x of g) if (sampleG.has(x)) hit++;
        score = Math.max(score, hit / Math.max(1, g.size));
      }
      return { tag: t, score: score + Math.min(t.count, 50) * 0.002 };
    });
    return scored.filter(s => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(s => s.tag);
  }
}

// 无 API 时的本地关键词启发式
const KEYWORD_TAGS = [
  [/写作|文案|润色|改写|文风|标题党/, '写作'],
  [/代码审查|code review|审查代码/i, '编程/代码审查'],
  [/编程|代码|函数|bug|调试|重构|python|javascript|typescript|java|rust|golang/i, '编程'],
  [/翻译|translate|英译中|中译英/i, '翻译'],
  [/总结|摘要|summar|tl;dr/i, '总结'],
  [/角色扮演|扮演|role.?play|你是(一位|一个)?/, '角色扮演'],
  [/midjourney|stable diffusion|dall-?e|绘画|出图|提示词画图/i, '绘画'],
  [/\bsql\b|数据库查询/i, '编程/SQL'],
  [/产品|需求|prd|用户故事|roadmap/i, '产品'],
  [/营销|推广|seo|小红书文案|带货/i, '营销'],
  [/学习|教程|费曼|讲解|教学/i, '学习'],
  [/数据分析|统计|报表|可视化|excel/i, '数据分析'],
  [/agent|智能体|autonomous/i, 'Agent'],
  [/\bmcp\b|model context protocol/i, 'MCP'],
  [/\bskill\b|技能/, 'Skill'],
];

export function heuristicTags(cleaned, hashtagCandidates = []) {
  const out = new Set();
  for (const [re, tag] of KEYWORD_TAGS) {
    if (re.test(cleaned)) out.add(normalizeTag(tag));
  }
  for (const h of hashtagCandidates) {
    const n = normalizeTag(h);
    if (n) out.add(n);
  }
  return [...out];
}
