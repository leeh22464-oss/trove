// Agent Skills 规范校验：解析 SKILL.md 的 YAML frontmatter，输出 errors / warnings / 修复建议。
// 规则参考 https://agentskills.io/specification 与 Anthropic best practices：
// name: <=64 字符，小写字母/数字/连字符，不以连字符开头结尾，无连续 --，不含保留词 anthropic/claude
// description: 非空，<=1024 字符，应写做什么+何时用，建议第三人称

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const RESERVED = ['anthropic', 'claude'];

export function parseFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { attrs: {}, body: String(md || ''), hasFm: false };
  const attrs = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      attrs[kv[1].toLowerCase()] = v;
    }
  }
  return { attrs, body: String(md || '').slice(m[0].length), hasFm: true, fmEnd: m[0].length };
}

export function validateSkill(md) {
  const errors = [];
  const warnings = [];
  const fixes = [];
  const { attrs, body, hasFm } = parseFrontmatter(md);

  if (!hasFm) {
    errors.push({ field: 'frontmatter', message: '缺少 YAML frontmatter（--- 包裹的头部）' });
    fixes.push({ field: 'frontmatter', suggestion: '在文件顶部添加 ---\\nname: <skill 名>\\ndescription: <做什么、何时用>\\n---' });
    return { errors, warnings, fixes, attrs, body };
  }

  const name = attrs.name ?? '';
  if (!name) {
    errors.push({ field: 'name', message: '缺少 name 字段' });
  } else {
    if (name.length > 64) errors.push({ field: 'name', message: `name 超过 64 字符（当前 ${name.length}）` });
    if (!NAME_RE.test(name)) {
      if (/[A-Z]/.test(name)) {
        errors.push({ field: 'name', message: 'name 必须全小写' });
        fixes.push({ field: 'name', suggestion: name.toLowerCase() });
      }
      if (/[^a-zA-Z0-9-]/.test(name)) errors.push({ field: 'name', message: 'name 只能包含小写字母、数字、连字符' });
    }
    if (name.startsWith('-') || name.endsWith('-')) errors.push({ field: 'name', message: 'name 不能以连字符开头或结尾' });
    if (name.includes('--')) {
      errors.push({ field: 'name', message: 'name 不能包含连续连字符 --' });
      fixes.push({ field: 'name', suggestion: name.replace(/-{2,}/g, '-') });
    }
    for (const w of RESERVED) {
      if (name.includes(w)) errors.push({ field: 'name', message: `name 不能包含保留词 "${w}"` });
    }
  }

  const desc = attrs.description ?? '';
  if (!desc) {
    errors.push({ field: 'description', message: '缺少 description 字段' });
  } else {
    if (desc.length > 1024) errors.push({ field: 'description', message: `description 超过 1024 字符（当前 ${desc.length}）` });
    if (desc.length < 20) warnings.push({ field: 'description', message: 'description 过短，应说明做什么和何时使用' });
    if (!/(when|use|用于|当|何时)/i.test(desc)) {
      warnings.push({ field: 'description', message: '建议 description 说明何时使用（when to use）' });
    }
    if (/^(i|we|you)\b/i.test(desc)) {
      warnings.push({ field: 'description', message: '建议使用第三人称描述（This skill...）' });
    }
  }

  if (attrs.license === '') warnings.push({ field: 'license', message: 'license 字段为空' });
  const allowed = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'version', 'author', 'homepage']);
  for (const k of Object.keys(attrs)) {
    if (!allowed.has(k)) warnings.push({ field: k, message: `未识别的 frontmatter 字段 "${k}"` });
  }

  if (!body.trim()) warnings.push({ field: 'body', message: 'frontmatter 之后没有正文内容' });

  return { errors, warnings, fixes, attrs, body };
}

export function sanitizeName(s) {
  let n = String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  for (const w of RESERVED) n = n.split(w).join('');
  return n.slice(0, 64).replace(/^-+|-+$/g, '') || 'my-skill';
}

// 简单 YAML 序列化（仅支持 name/description/license/allowed-tools 等扁平字段）
export function buildSkillMd({ name, description, license, extra = {}, body = '' }) {
  const lines = ['---'];
  lines.push(`name: ${sanitizeName(name)}`);
  lines.push(`description: ${JSON.stringify(description || '')}`);
  if (license) lines.push(`license: ${license}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}
