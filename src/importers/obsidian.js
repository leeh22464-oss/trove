// Obsidian vault 导入：读取 .md，解析 frontmatter、#tags、[[wikilinks]]。
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../skill.js';

export function walkMarkdown(dir, max = 2000) {
  const files = [];
  const stack = [dir];
  while (stack.length && files.length < max) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.md$/i.test(e.name)) files.push(p);
    }
  }
  return files;
}

export function parseMarkdownFile(content) {
  const { attrs, body, hasFm } = parseFrontmatter(content);
  const tags = new Set();
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{1,60})/gu)) tags.add(m[1]);
  if (attrs.tags) {
    for (const t of String(attrs.tags).split(/[,\s]+/)) if (t) tags.add(t.replace(/^#/, ''));
  }
  const wikilinks = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
  return {
    attrs,
    body: body.trim(),
    tags: [...tags],
    wikilinks,
    title: attrs.title || attrs.name || '',
  };
}

export function importVault(dir) {
  const files = walkMarkdown(dir);
  const out = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const parsed = parseMarkdownFile(content);
    out.push({
      path: path.relative(dir, f),
      title: parsed.title || path.basename(f, '.md'),
      content: parsed.body,
      tags: parsed.tags,
      wikilinks: parsed.wikilinks,
      props: parsed.attrs,
    });
  }
  return out;
}
