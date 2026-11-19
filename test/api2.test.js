import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { openDb, Store } from '../src/db.js';
import { paddleSelfhost } from '../src/ocr/paddleSelfhost.js';

async function makeApp(opts = {}) {
  const db = openDb(':memory:');
  const store = new Store(db);
  const app = await buildApp({ db, store, serveStatic: false, ...opts });
  return { app, store, db };
}

test('paddle-selfhost 解析 rec_texts', async () => {
  const st = { get: (k) => ({ paddle_selfhost_url: 'http://x' }[k] ?? '') };
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['a', 'b'] } }] } }) });
  const r = await paddleSelfhost(st, { fetchImpl }).extract(Buffer.from('x'), 'image/png');
  assert.equal(r.text, 'a\nb');
});

test('标签 API：create/pending/approve/merge', async () => {
  const { app } = await makeApp();
  const t = (await app.inject({ method: 'POST', url: '/api/tags', payload: { name: 'AI' } })).json();
  const p = (await app.inject({ method: 'POST', url: '/api/tags', payload: { name: '人工智能' } })).json();
  // merge AI → 人工智能
  const m = await app.inject({ method: 'POST', url: '/api/tags/merge', payload: { from: t.id, to: p.id } });
  assert.ok(m.json().ok);
  const all = (await app.inject({ method: 'GET', url: '/api/tags' })).json().tags;
  const target = all.find(x => x.name === '人工智能');
  assert.ok(JSON.parse(target.aliases_json).includes('ai'));
  await app.close();
});

test('PUT /api/settings：掩码值回写不覆盖真实密钥', async () => {
  const { app, store } = await makeApp();
  store.settings.set('llm_api_key', 'sk-supersecret12345');
  const view = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...view, llm_model: 'new-model' } });
  assert.equal(store.settings.get('llm_api_key'), 'sk-supersecret12345');
  assert.equal(store.settings.get('llm_model'), 'new-model');
  await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm_api_key: 'sk-changed-value-999' } });
  assert.equal(store.settings.get('llm_api_key'), 'sk-changed-value-999');
  await app.close();
});

test('capture 远程图片 URL：内网地址不发出请求', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return { ok: false, status: 404, headers: new Headers() }; };
  const { app } = await makeApp({ fetchImpl });
  const r = await app.inject({
    method: 'POST', url: '/api/capture',
    payload: { text: '带内网图片的内容', images: ['http://127.0.0.1/a.png', 'http://169.254.169.254/x.png', 'http://10.0.0.5/y.png'] },
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(calls, []);
  assert.equal(r.json().items[0].assets.length, 0);
  await app.close();
});

test('skill 校验 API', async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: 'POST', url: '/api/skill/validate', payload: { content: '---\nname: BadName\ndescription: "x"\n---\nbody' } });
  assert.ok(r.json().errors.length >= 1);
  await app.close();
});

test('chat 导入：解析候选 + commit 入库', async () => {
  const { app } = await makeApp();
  const data = [{
    title: 's',
    mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['你是一位资深翻译，请翻译：\n1. 要求信达雅\n2. 保持语气\n3. {{text}}'] }, create_time: 1 } },
      b: { message: { author: { role: 'assistant' }, content: { parts: ['ok'] }, create_time: 2 } },
    },
  }];
  const r = await app.inject({ method: 'POST', url: '/api/import/chat', payload: { format: 'chatgpt', data } });
  const cands = r.json().candidates;
  assert.ok(cands.length >= 1);
  const c = await app.inject({ method: 'POST', url: '/api/import/chat/commit', payload: { candidates: cands } });
  assert.ok(c.json().created.length >= 1);
  await app.close();
});

test('导出 JSON / prompts.md / obsidian zip', async () => {
  const { app } = await makeApp();
  await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '你是一个助手，请总结下面内容，要求：要点列表', kind: 'prompt' } });
  const j = await app.inject({ method: 'GET', url: '/api/export/json' });
  assert.ok(JSON.parse(j.body).items.length >= 1);
  const md = await app.inject({ method: 'GET', url: '/api/export/prompts.md' });
  assert.ok(md.body.includes('你是一个助手'));
  const z = await app.inject({ method: 'GET', url: '/api/export/obsidian?zip=1' });
  assert.equal(z.headers['content-type'], 'application/zip');
  assert.ok(z.rawPayload.length > 100);
  await app.close();
});

test('资产路径防穿越', async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: 'GET', url: '/assets/..%2F..%2Fetc%2Fpasswd' });
  assert.ok([400, 404].includes(r.statusCode));
  const r2 = await app.inject({ method: 'GET', url: '/assets/notahexfile.png' });
  assert.ok([400, 404].includes(r2.statusCode));
  await app.close();
});

test('dryrun 未配置 LLM 返回提示', async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: 'POST', url: '/api/dryrun', payload: { text: 'x' } });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test('reset-token 轮换', async () => {
  const { app, store } = await makeApp();
  const t1 = store.settings.get('capture_token') || store.settings.ensureCaptureToken();
  const r = await app.inject({ method: 'POST', url: '/api/settings/reset-token' });
  const t2 = r.json().token;
  assert.notEqual(t1, t2);
  // 旧 token 失效
  const bad = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'https://evil.com', authorization: `Bearer ${t1}` }, payload: { text: 'x' } });
  assert.equal(bad.statusCode, 403);
  // 新 token 生效
  const ok = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'https://evil.com', authorization: `Bearer ${t2}` }, payload: { text: '新 token 写入的内容' } });
  assert.equal(ok.statusCode, 200);
  await app.close();
});
