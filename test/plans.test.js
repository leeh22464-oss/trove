import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { openDb, Store } from '../src/db.js';
import { PlanService } from '../src/plans.js';
import { JobRunner } from '../src/jobs.js';

const count = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

async function makeApp(opts = {}) {
  const db = openDb(':memory:');
  const store = new Store(db);
  const app = await buildApp({ db, store, serveStatic: false, ...opts });
  return { app, store, db };
}

function addItem(db, title, content, notes = {}) {
  return Number(db.prepare("INSERT INTO items(title,content,raw,status,ai_notes) VALUES(?,?,?,'inbox',?)")
    .run(title, content, content, JSON.stringify(notes)).lastInsertRowid);
}

const post = (app, url, payload = {}) => app.inject({ method: 'POST', url, payload });

test('生成方案不写 tags / item_tags / collections', async () => {
  const { app, db } = await makeApp();
  addItem(db, 'a', '帮我写一个 Python 函数来做数据分析');
  addItem(db, 'b', '请润色这段文字', { suggested_tags: ['写作/润色'], });
  const before = ['tags', 'item_tags', 'collections', 'collection_items'].map(t => count(db, t));
  const r = await post(app, '/api/classify/plans', { scope: 'inbox' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().state, 'draft');
  assert.equal(r.json().plan.items.length, 2);
  assert.deepEqual(['tags', 'item_tags', 'collections', 'collection_items'].map(t => count(db, t)), before);
  await app.close();
});

test('无 LLM 时启发式兜底有结果', async () => {
  const { app, db } = await makeApp();
  addItem(db, 'a', '帮我写一个 Python 函数来做数据分析');
  const r = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  const tags = r.plan.items[0].add_tags;
  assert.ok(tags.includes('编程'));
  assert.deepEqual(r.plan.items[0].new_tags, tags);
  await app.close();
});

test('PATCH 覆盖后 apply，落库结果正确', async () => {
  const { app, db } = await makeApp();
  const a = addItem(db, 'a', '帮我写一个 Python 函数');
  const b = addItem(db, 'b', '请润色这段文字');
  const plan = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  const p = await app.inject({
    method: 'PATCH', url: `/api/classify/plans/${plan.id}`,
    payload: { items: [{ item_id: a, add_tags: ['#工具/脚本'], collection: '常用' }, { item_id: b, exclude: true }] },
  });
  assert.equal(p.statusCode, 200);
  assert.deepEqual(p.json().plan.items.find(i => i.item_id === a).add_tags, ['工具/脚本']);
  const r = await post(app, `/api/classify/plans/${plan.id}/apply`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().state, 'applied');
  const tagsA = db.prepare('SELECT t.name, it.source FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?').all(a);
  assert.deepEqual(tagsA.map(t => t.name), ['工具/脚本']);
  assert.equal(tagsA[0].source, 'ai');
  assert.equal(count(db, 'item_tags') > 0, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM item_tags WHERE item_id=?').get(b).c, 0);
  const col = db.prepare('SELECT c.name FROM collection_items ci JOIN collections c ON c.id=ci.collection_id WHERE ci.item_id=?').all(a);
  assert.deepEqual(col.map(c => c.name), ['常用']);
  await app.close();
});

test('apply 事务性：中途失败无部分写入，仍是 draft', async () => {
  const { store, db } = await makeApp().then(r => ({ ...r }));
  addItem(db, 'a', 'x', { suggested_tags: ['甲'] });
  addItem(db, 'b', 'y', { suggested_tags: ['乙'] });
  addItem(db, 'c', 'z', { suggested_tags: ['丙'] });
  const svc = new PlanService(store, { llm: null });
  const view = await svc.create({ scope: 'inbox' });
  assert.throws(() => svc.apply(view.id, { failAfter: 1 }), /injected failure/);
  assert.equal(count(db, 'tags'), 0);
  assert.equal(count(db, 'item_tags'), 0);
  assert.equal(svc.get(view.id).state, 'draft');
});

test('重复 apply 返回 409', async () => {
  const { app, db } = await makeApp();
  addItem(db, 'a', 'x', { suggested_tags: ['甲'] });
  const plan = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  assert.equal((await post(app, `/api/classify/plans/${plan.id}/apply`)).statusCode, 200);
  assert.equal((await post(app, `/api/classify/plans/${plan.id}/apply`)).statusCode, 409);
  const patch = await app.inject({ method: 'PATCH', url: `/api/classify/plans/${plan.id}`, payload: { items: [] } });
  assert.equal(patch.statusCode, 409);
  await app.close();
});

test('undo 后标签关联、新建标签、集合恢复到应用前', async () => {
  const { app, db } = await makeApp();
  const a = addItem(db, 'a', 'x', { suggested_tags: ['新标签'] });
  const old = Number(db.prepare("INSERT INTO tags(name) VALUES('旧标签')").run().lastInsertRowid);
  db.prepare("INSERT INTO item_tags(item_id,tag_id,source) VALUES(?,?,'user')").run(a, old);
  const plan = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  await app.inject({ method: 'PATCH', url: `/api/classify/plans/${plan.id}`, payload: { items: [{ item_id: a, collection: '集合甲' }] } });
  await post(app, `/api/classify/plans/${plan.id}/apply`);
  assert.equal(count(db, 'collections'), 1);
  const u = await post(app, `/api/classify/plans/${plan.id}/undo`);
  assert.equal(u.statusCode, 200);
  assert.equal(u.json().state, 'undone');
  assert.deepEqual(db.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?').all(a).map(t => t.name), ['旧标签']);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tags WHERE name='新标签'").get().c, 0);
  assert.equal(count(db, 'collections'), 0);
  assert.equal((await post(app, `/api/classify/plans/${plan.id}/undo`)).statusCode, 409);
  await app.close();
});

test('超过 50 条被截断', async () => {
  const { app, db } = await makeApp();
  for (let i = 0; i < 53; i++) addItem(db, `t${i}`, `内容${i}`, { suggested_tags: ['x'] });
  const r = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  assert.equal(r.plan.items.length, 50);
  assert.equal(r.plan.truncated, true);
  await app.close();
});

test('exclude 的条目不会被打标签；discard 后不可应用', async () => {
  const { app, db } = await makeApp();
  const a = addItem(db, 'a', 'x', { suggested_tags: ['甲'] });
  const plan = (await post(app, '/api/classify/plans', { scope: 'ids', ids: [a] })).json();
  await app.inject({ method: 'PATCH', url: `/api/classify/plans/${plan.id}`, payload: { items: [{ item_id: a, exclude: true }] } });
  await post(app, `/api/classify/plans/${plan.id}/apply`);
  assert.equal(count(db, 'item_tags'), 0);
  const plan2 = (await post(app, '/api/classify/plans', { scope: 'ids', ids: [a] })).json();
  assert.equal((await post(app, `/api/classify/plans/${plan2.id}/discard`)).json().state, 'discarded');
  assert.equal((await post(app, `/api/classify/plans/${plan2.id}/apply`)).statusCode, 409);
  await app.close();
});

test('LLM 单条失败不影响整体', async () => {
  const llm = {
    available: () => true,
    extract: async (content) => {
      if (content.includes('坏')) throw new Error('boom');
      return { parsed: { tags: ['好标签'], collection_hint: '好集合' } };
    },
  };
  const { app, db } = await makeApp({ llm });
  addItem(db, 'a', '好内容');
  addItem(db, 'b', '坏内容');
  const r = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  const good = r.plan.items.find(i => i.title === 'a');
  const bad = r.plan.items.find(i => i.title === 'b');
  assert.deepEqual(good.add_tags, ['好标签']);
  assert.equal(good.collection, '好集合');
  assert.deepEqual(bad.add_tags, []);
  assert.match(bad.error, /boom/);
  await app.close();
});

test('doClassify 不再创建标签，但写入 suggested_tags', async () => {
  const { store, db } = await makeApp();
  const id = addItem(db, 't', '帮我写一个 Python 函数来做数据分析');
  const runner = new JobRunner(store, { llm: { available: () => false }, ocr: null, emit: () => {} });
  await runner.doClassify({ item_id: id });
  assert.equal(count(db, 'tags'), 0);
  assert.equal(count(db, 'item_tags'), 0);
  const notes = JSON.parse(db.prepare('SELECT ai_notes FROM items WHERE id=?').get(id).ai_notes);
  assert.ok(notes.suggested_tags.includes('编程'));
});

test('带 JSON Content-Type 的空 body POST 可用；内网 URL 抓取返回 400', async () => {
  const { app, db } = await makeApp();
  addItem(db, 'a', 'x', { suggested_tags: ['甲'] });
  const plan = (await post(app, '/api/classify/plans', { scope: 'inbox' })).json();
  const r = await app.inject({ method: 'POST', url: `/api/classify/plans/${plan.id}/apply`, headers: { 'content-type': 'application/json' } });
  assert.equal(r.statusCode, 200);
  const ssrf = await post(app, '/api/capture', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(ssrf.statusCode, 400);
  await app.close();
});

test('含空行和 --- 的文本默认整段一条；split 开启后按 ===== 拆分', async () => {
  const { app } = await makeApp();
  const skill = '---\nname: commit-writer\ndescription: 生成提交信息\n---\n\n# 标题\n\n1. 第一步\n\n2. 第二步';
  const r = await app.inject({ method: 'POST', url: '/api/capture', headers: { 'content-type': 'application/json' }, payload: { text: skill } });
  assert.equal(r.json().count, 1);
  assert.equal(r.json().items[0].raw, skill);
  const multi = await app.inject({ method: 'POST', url: '/api/capture', headers: { 'content-type': 'application/json' }, payload: { text: '第一条完全不同的 prompt 内容用于测试拆分\n\n含空行\n=====\n第二条另外的文字内容也要足够长以便区分', split: true } });
  assert.equal(multi.json().count, 2);
  await app.close();
});

test('/capture 回退表单（urlencoded）可保存；跨源 urlencoded 被拒', async () => {
  const { app } = await makeApp();
  const ok = await app.inject({ method: 'POST', url: '/api/capture', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'text=' + encodeURIComponent('请把下面的内容翻译成英文并保持语气一致') });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().count, 1);
  const evil = await app.inject({ method: 'POST', url: '/api/capture', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, payload: 'text=x' });
  assert.equal(evil.statusCode, 403);
  await app.close();
});

test('restore-raw 还原正文并保留版本', async () => {
  const { app, db } = await makeApp();
  const id = addItem(db, 't', '精简后', {});
  db.prepare('UPDATE items SET raw=? WHERE id=?').run('原文很长很长', id);
  const r = await post(app, `/api/items/${id}/restore-raw`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().content, '原文很长很长');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM item_versions WHERE item_id=?').get(id).c >= 1);
  await app.close();
});
