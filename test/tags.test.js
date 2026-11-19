import test from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from './helpers.js';
import { TagService, normalizeTag, heuristicTags } from '../src/tags.js';

test('规范化：小写、去#、去标点、嵌套、限深', () => {
  assert.equal(normalizeTag('#AI'), 'ai');
  assert.equal(normalizeTag('写作 / 润色'), '写作/润色');
  assert.equal(normalizeTag('a\\b_c'), 'a/b/c');
  assert.equal(normalizeTag('a/b/c/d'), 'a/b/c');
  assert.equal(normalizeTag('Hello, World!'), 'hello world');
});

test('create / resolve / alias 命中', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  const t = tags.create('人工智能');
  tags.merge(tags.create('AI').id, t.id);
  const r = tags.resolve('AI');
  assert.equal(r.name, '人工智能');
});

test('嵌套：父标签检索包含子标签', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  const parent = tags.create('写作');
  const child = tags.create('写作/润色');
  const ids = tags.expandIds('写作');
  assert.ok(ids.includes(parent.id));
  assert.ok(ids.includes(child.id));
});

test('merge：条目关联迁移且去重，原名成为 alias', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  const itemId = s.db.prepare("INSERT INTO items(title,content) VALUES('t','c')").run().lastInsertRowid;
  const a = tags.create('AI');
  const b = tags.create('人工智能');
  tags.tagItem(itemId, a.id);
  tags.tagItem(itemId, b.id);
  tags.merge(a.id, b.id);
  const itemTags = tags.tagsOfItem(itemId);
  assert.equal(itemTags.length, 1);
  assert.equal(itemTags[0].name, '人工智能');
  assert.ok(JSON.parse(b.name === '人工智能' ? tags.getByName('人工智能').aliases_json : '[]').includes('ai'));
  assert.equal(tags.resolve('AI').name, '人工智能');
});

test('pending 流程：create pending → approve → active', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  const t = tags.create('新标签', { status: 'pending' });
  assert.equal(t.status, 'pending');
  tags.approve(t.id);
  assert.equal(tags.getByName('新标签').status, 'active');
});

test('reject 删除 pending 及其关联', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  const itemId = s.db.prepare("INSERT INTO items(title,content) VALUES('t','c')").run().lastInsertRowid;
  const t = tags.create('坏标签', { status: 'pending' });
  tags.tagItem(itemId, t.id);
  tags.reject(t.id);
  assert.equal(tags.getByName('坏标签'), undefined);
  assert.equal(tags.tagsOfItem(itemId).length, 0);
});

test('suggestRelevant 不返回全部标签', () => {
  const s = memStore();
  const tags = new TagService(s.db);
  tags.create('写作');
  tags.create('编程');
  tags.create('完全无关的标签');
  const rel = tags.suggestRelevant('帮我润色这篇写作练习', 30);
  const names = rel.map(t => t.name);
  assert.ok(names.includes('写作'));
  assert.ok(!names.includes('完全无关的标签'));
});

test('heuristicTags 关键词', () => {
  const t = heuristicTags('帮我写一个 Python 函数来做数据分析');
  assert.ok(t.includes('编程'));
  assert.ok(t.includes('数据分析'));
});
