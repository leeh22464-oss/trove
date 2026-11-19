import test from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from './helpers.js';
import { Searcher, parseQuery } from '../src/search.js';
import { TagService } from '../src/tags.js';

function setup() {
  const s = memStore();
  const tags = new TagService(s.db);
  const ins = s.db.prepare("INSERT INTO items(title,content,summary,kind,status) VALUES(?,?,?,?,?)");
  const i1 = ins.run('写作润色提示词', '请帮我润色下面的文字，保持原意', '润色', 'prompt', 'inbox').lastInsertRowid;
  const i2 = ins.run('Python 代码审查', 'Review this Python code for bugs', 'code review', 'prompt', 'inbox').lastInsertRowid;
  const i3 = ins.run('Git 笔记', '常用 git 命令备忘', 'git', 'note', 'curated').lastInsertRowid;
  const w = tags.create('写作'); const wr = tags.create('写作/润色'); const p = tags.create('编程');
  tags.tagItem(i1, wr.id); tags.tagItem(i2, p.id); tags.tagItem(i3, p.id);
  for (const id of [i1, i2, i3]) s.ftsUpdate(id);
  return { s, tags, i1, i2, i3, searcher: new Searcher(s.db) };
}

test('中文子串检索（trigram）', () => {
  const { searcher } = setup();
  const { rows } = searcher.search('提示词');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '写作润色提示词');
});

test('英文子串', () => {
  const { searcher } = setup();
  const { rows } = searcher.search('Python');
  assert.equal(rows.length, 1);
});

test('tag: 过滤器', () => {
  const { searcher, i1, i3 } = setup();
  const { rows } = searcher.search('tag:写作');
  assert.ok(rows.some(r => r.id === i1)); // 父标签命中子标签条目
  const { rows: r2 } = searcher.search('tag:编程');
  assert.ok(r2.some(r => r.id === i3));
});

test('kind: 过滤', () => {
  const { searcher } = setup();
  const { rows } = searcher.search('kind:note');
  assert.equal(rows.length, 1);
});

test('-排除', () => {
  const { searcher, i1 } = setup();
  const { rows } = searcher.search('kind:prompt -Python');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, i1);
});

test('"精确短语"', () => {
  const { searcher } = setup();
  const { rows } = searcher.search('"保持原意"');
  assert.equal(rows.length, 1);
});

test('1-2 字查询退化为 LIKE', () => {
  const { searcher } = setup();
  const { rows } = searcher.search('润色');
  assert.equal(rows.length, 1);
  const { rows: r2 } = searcher.search('git');
  assert.ok(r2.length >= 1);
});

test('is:favorite / status:trash', () => {
  const { s, searcher, i1 } = setup();
  s.db.prepare('UPDATE items SET favorite=1 WHERE id=?').run(i1);
  const { rows } = searcher.search('is:favorite');
  assert.equal(rows.length, 1);
  s.db.prepare("UPDATE items SET status='trash' WHERE id=?").run(i1);
  const { rows: trash } = searcher.search('', { status: 'trash' });
  assert.equal(trash.length, 1);
});

test('parseQuery 解析多前缀', () => {
  const p = parseQuery('tag:a kind:prompt "hello world" -bad foo');
  assert.deepEqual(p.tags, ['a']);
  assert.deepEqual(p.kinds, ['prompt']);
  assert.deepEqual(p.phrases, ['hello world']);
  assert.deepEqual(p.neg, [{ text: 'bad' }]);
  assert.deepEqual(p.text, ['foo']);
});
