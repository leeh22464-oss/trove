import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { openDb, Store } from '../src/db.js';
import { assertPublicUrl } from '../src/security.js';

async function makeApp(opts = {}) {
  const db = openDb(':memory:');
  const store = new Store(db);
  const app = await buildApp({ db, store, serveStatic: false, ...opts });
  const token = store.settings.ensureCaptureToken();
  return { app, store, db, token };
}

test('capture：无 token 同源允许，外部带 token 允许，坏 Origin 403', async () => {
  const { app, token } = await makeApp();
  // 无 Origin（本机）
  let r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '测试内容一二三四五' } });
  assert.equal(r.statusCode, 200);

  // 带 Origin 本机
  r = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'http://localhost:5173', host: 'localhost:5173' }, payload: { text: '不同内容六七八九十' } });
  assert.equal(r.statusCode, 200);

  // 扩展 Origin 无 token → 允许（白名单）
  r = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'chrome-extension://abc' }, payload: { text: '扩展内容测试一二三四' } });
  assert.equal(r.statusCode, 200);

  // 坏 Origin 无 token → 403
  r = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'https://evil.com' }, payload: { text: '恶意内容测试一二三' } });
  assert.equal(r.statusCode, 403);

  // 坏 Origin 但带正确 token → 允许
  r = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'https://evil.com', authorization: `Bearer ${token}` }, payload: { text: '合法token内容测试' } });
  assert.equal(r.statusCode, 200);

  // 错误 token → 403
  r = await app.inject({ method: 'POST', url: '/api/capture', headers: { origin: 'https://evil.com', authorization: 'Bearer wrong' }, payload: { text: '错token' } });
  assert.equal(r.statusCode, 403);
  await app.close();
});

test('capture：精确去重返回 duplicate', async () => {
  const { app } = await makeApp();
  const text = '这是一段用于测试重复的文本内容，比较长';
  await app.inject({ method: 'POST', url: '/api/capture', payload: { text } });
  const r2 = await app.inject({ method: 'POST', url: '/api/capture', payload: { text } });
  const body = r2.json();
  assert.ok(body.duplicate.exact.length >= 1);
  assert.equal(body.items.length, 0);
  await app.close();
});

test('capture：相同 URL 规范化去重', async () => {
  const { app } = await makeApp();
  await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '带链接的内容一', url: 'https://x.com/a?utm_source=t' } });
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '不同内容但同链接', url: 'https://x.com/a' } });
  assert.ok(r.json().duplicate.exact.length >= 1);
  await app.close();
});

test('capture：同一帖子不同选区都可保存，相同选区仍按文本去重', async () => {
  const { app } = await makeApp();
  const url = 'https://www.xiaohongshu.com/explore/abc123';
  const first = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '这是帖子中第一段被选中的文字内容', url, source: 'extension-selection' } });
  const second = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '这是帖子中另外一段完全不同的文字内容', url, source: 'extension-selection' } });
  assert.equal(first.json().count, 1);
  assert.equal(second.json().count, 1);
  assert.equal(second.json().duplicate.exact.length, 0);
  const repeated = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '这是帖子中第一段被选中的文字内容', url, source: 'extension-selection' } });
  assert.equal(repeated.json().count, 0);
  assert.ok(repeated.json().duplicate.exact.some(d => d.via === 'hash'));
  await app.close();
});

test('异步 job：mock LLM 后 classify 更新条目', async () => {
  const fakeLlm = {
    available: () => true,
    async extract(cleaned) {
      return {
        parsed: {
          kind: 'prompt', title: 'AI 标题', content: cleaned, summary: 'AI 摘要',
          tags: ['写作', 'AI标签'], variables: ['text'], target_models: ['gpt'],
          is_prompt_confidence: 0.9, lang: 'zh',
        }, truncated: false,
      };
    },
    async test() { return { ok: true }; },
  };
  const { app, store } = await makeApp({ llm: fakeLlm });
  store.settings.set('llm_api_key', 'k');
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '请翻译这段话：你好世界' } });
  const id = r.json().items[0].id;
  await app.runner.runPending();
  const it = (await app.inject({ method: 'GET', url: `/api/items/${id}` })).json();
  assert.equal(it.title, 'AI 标题');
  assert.equal(it.summary, 'AI 摘要');
  assert.equal(it.tags.length, 0);
  assert.deepEqual(JSON.parse(it.ai_notes).suggested_tags, ['写作', 'AI标签']);
  await app.close();
});

test('异步分类：推荐网站生成资源类型并把官网链接置顶', async () => {
  const fakeLlm = {
    available: () => true,
    async extract(cleaned) {
      return { parsed: {
        kind: 'resource', title: 'Notion 项目管理', content: cleaned, summary: '项目管理应用',
        resource: { name: 'Notion', type: 'app', official_url: 'https://www.notion.so/', url_confidence: 0.95 },
      }, truncated: false };
    },
  };
  const { app } = await makeApp({ llm: fakeLlm });
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '推荐使用 Notion 管理项目，适合团队协作。' } });
  const id = r.json().items[0].id;
  await app.runner.runPending();
  const it = (await app.inject({ method: 'GET', url: `/api/items/${id}` })).json();
  assert.equal(it.kind, 'resource');
  assert.ok(it.content.startsWith('- [Notion](<https://www.notion.so/>)\n\n'));
  const props = JSON.parse(it.props_json);
  assert.equal(props.resource_name, 'Notion');
  assert.equal(props.resource_url, 'https://www.notion.so/');
  await app.close();
});

test('异步分类：资源清单把多个官网链接置顶成可点击列表', async () => {
  const fakeLlm = {
    available: () => true,
    async extract(cleaned) {
      return { parsed: {
        kind: 'resource', title: 'UI 组件库清单', content: cleaned, summary: '组件库合集',
        resource: {
          name: 'UI 组件库清单', type: 'website',
          items: [
            { name: 'shadcn/ui', type: 'website', official_url: 'https://ui.shadcn.com/', url_confidence: 0.98 },
            { name: 'Ant Design', type: 'website', official_url: 'https://ant.design/', url_confidence: 0.98 },
            { name: 'Half Sure', type: 'website', official_url: 'https://half.example', url_confidence: 0.6 },
            { name: 'Naive UI', type: 'website', official_url: '', url_confidence: 0.4 },
          ],
        },
      }, truncated: false };
    },
  };
  const { app } = await makeApp({ llm: fakeLlm });
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '组件库清单：shadcn/ui、Ant Design、Naive UI。' } });
  const id = r.json().items[0].id;
  await app.runner.runPending();
  const it = (await app.inject({ method: 'GET', url: `/api/items/${id}` })).json();
  assert.equal(it.kind, 'resource');
  // 有链接的进置顶清单（0.6 的标「待确认」），无链接的 Naive UI 不进，顺序保持
  assert.ok(it.content.startsWith('- [shadcn/ui](<https://ui.shadcn.com/>)\n- [Ant Design](<https://ant.design/>)\n- [Half Sure](<https://half.example/>)（待确认）\n\n'));
  const props = JSON.parse(it.props_json);
  assert.equal(props.resource_items.length, 4);
  await app.close();
});

test('job 失败退避与 retry-failed', async () => {
  const badLlm = { available: () => true, async extract() { throw new Error('llm down'); } };
  const { app, store, db } = await makeApp({ llm: badLlm });
  store.settings.set('llm_api_key', 'k');
  await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '会失败的内容' } });
  await app.runner.runPending();
  const job = db.prepare('SELECT * FROM jobs LIMIT 1').get();
  assert.equal(job.state, 'pending'); // 退避重试而非直接 failed
  assert.ok(job.last_error.includes('llm down'));
  const r = await app.inject({ method: 'POST', url: '/api/jobs/retry-failed' });
  assert.ok(r.json().count >= 0);
  await app.close();
});

test('SSRF：内网地址全部拦截', async () => {
  const ips = ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'file:///etc/passwd', 'ftp://x/'];
  for (const u of ips) {
    await assert.rejects(() => assertPublicUrl(u), /不允许|只允许|格式/);
  }
});

test('静态前端：首页与 vendor 依赖可访问', async () => {
  const { app } = await makeApp({ serveStatic: true });
  for (const [url, type] of [
    ['/', 'text/html'],
    ['/css/tokens.css', 'css'],
    ['/css/app.css', 'css'],
    ['/js/app.js', 'javascript'],
    ['/vendor/webawesome/styles/webawesome.css', 'css'],
    ['/vendor/webawesome/webawesome.loader.js', 'javascript'],
    ['/vendor/marked/marked.esm.js', 'javascript'],
    ['/vendor/dompurify/purify.es.mjs', 'javascript'],
    ['/img/icons.svg', 'svg'],
  ]) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 200, `${url} 应可访问`);
    assert.match(r.headers['content-type'] || '', new RegExp(type.split('/').pop()), `${url} 类型应含 ${type}`);
  }
  // 不存在的资源 404，不返回 index.html 兜底导致隐藏错误
  const missing = await app.inject({ method: 'GET', url: '/vendor/webawesome/no-such-file.js' });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test('批量：仅回收站条目可永久删除，其它状态不受影响', async () => {
  const { app } = await makeApp();
  const id1 = (await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '测试批量一' } })).json().items[0].id;
  const id2 = (await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '测试批量二' } })).json().items[0].id;
  // 把 id1 移到回收站，id2 留在收件箱
  await app.inject({ method: 'PATCH', url: `/api/items/${id1}`, payload: { status: 'trash' } });
  // 永久删除：只有回收站的被删，收件箱的不动
  const r = await app.inject({ method: 'POST', url: '/api/items/batch', payload: { ids: [id1, id2], action: 'delete' } });
  assert.equal(r.json().ok, true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/items/${id1}` })).json().error, 'not found');
  assert.equal((await app.inject({ method: 'GET', url: `/api/items/${id2}` })).json().id, id2); // 还在
  await app.close();
});

test('GET /api/settings 不回传明文密钥', async () => {
  const { app, store } = await makeApp();
  store.settings.set('llm_api_key', 'sk-supersecret12345');
  store.settings.set('paddle_token', 'paddle-secret-token');
  const r = await app.inject({ method: 'GET', url: '/api/settings' });
  const body = r.json();
  assert.ok(!JSON.stringify(body).includes('sk-supersecret12345'));
  assert.ok(!JSON.stringify(body).includes('paddle-secret-token'));
  assert.ok(body.llm_api_key.includes('****'));
  await app.close();
});

test('编辑产生版本，可回滚', async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '原始内容版本一' } });
  const id = r.json().items[0].id;
  await app.inject({ method: 'PATCH', url: `/api/items/${id}`, payload: { content: '修改后的内容版本二' } });
  const versions = (await app.inject({ method: 'GET', url: `/api/items/${id}/versions` })).json();
  assert.ok(versions.length >= 1);
  const vid = versions[0].id;
  await app.inject({ method: 'POST', url: `/api/versions/${vid}/restore` });
  const it = (await app.inject({ method: 'GET', url: `/api/items/${id}` })).json();
  assert.equal(it.content, '原始内容版本一');
  await app.close();
});

test('回收站：trash → restore → empty 需 confirm', async () => {
  const { app } = await makeApp();
  const r = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '待删除的条目' } });
  const id = r.json().items[0].id;
  await app.inject({ method: 'PATCH', url: `/api/items/${id}`, payload: { status: 'trash' } });
  let trash = (await app.inject({ method: 'GET', url: '/api/items?status=trash' })).json();
  assert.equal(trash.rows.length, 1);
  await app.inject({ method: 'POST', url: `/api/items/${id}/restore` });
  trash = (await app.inject({ method: 'GET', url: '/api/items?status=trash' })).json();
  assert.equal(trash.rows.length, 0);
  // 清空需 confirm
  await app.inject({ method: 'PATCH', url: `/api/items/${id}`, payload: { status: 'trash' } });
  const bad = await app.inject({ method: 'POST', url: '/api/trash/empty', payload: {} });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/api/trash/empty', payload: { confirm: 'YES' } });
  assert.equal(ok.json().deleted, 1);
  await app.close();
});

test('批量操作 + 撤销信息', async () => {
  const { app } = await makeApp();
  const r1 = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '批量一' } });
  const r2 = await app.inject({ method: 'POST', url: '/api/capture', payload: { text: '批量二' } });
  const ids = [r1.json().items[0].id, r2.json().items[0].id];
  const r = await app.inject({ method: 'POST', url: '/api/items/batch', payload: { ids, action: 'status', status: 'curated' } });
  assert.equal(r.json().undo.length, 2);
  const rows = (await app.inject({ method: 'GET', url: '/api/items?status=all' })).json().rows;
  assert.ok(rows.every(x => x.status === 'curated'));
  await app.close();
});

test('OPTIONS 预检：本机/扩展放行，坏 Origin 403', async () => {
  const { app } = await makeApp();
  let r = await app.inject({ method: 'OPTIONS', url: '/api/capture', headers: { origin: 'chrome-extension://x' } });
  assert.equal(r.statusCode, 204);
  r = await app.inject({ method: 'OPTIONS', url: '/api/capture', headers: { origin: 'https://evil.com' } });
  assert.equal(r.statusCode, 403);
  await app.close();
});
