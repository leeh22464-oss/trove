import test from 'node:test';
import assert from 'node:assert/strict';
import { tolerantJsonParse, overlapRatio, applyExtraction, LlmClient } from '../src/llm.js';

test('tolerantJsonParse：标准、围栏、首尾大括号', () => {
  assert.deepEqual(tolerantJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(tolerantJsonParse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tolerantJsonParse('前置废话 {"a":1} 后置'), { a: 1 });
  assert.equal(tolerantJsonParse('not json'), null);
});

test('overlapRatio：高重叠 1，低重叠 <0.5', () => {
  const cleaned = '你是一位资深编辑，请帮我润色下面的文字，保持原意，语言流畅自然。';
  assert.equal(overlapRatio(cleaned, cleaned), 1);
  const low = overlapRatio('完全重写的内容，跟原文没有任何关系哦。', cleaned);
  assert.ok(low < 0.5, String(low));
});

test('护栏：重叠不足时丢弃 LLM content 保留元数据', () => {
  const cleaned = '请把下面这段中文翻译成英文，要求信达雅：{{text}}';
  const parsed = {
    kind: 'prompt', title: '翻译', content: '这是AI编造的内容，跟原文完全不一样。',
    summary: '翻译', tags: ['翻译'], variables: ['text'], lang: 'zh',
  };
  const ap = applyExtraction(parsed, cleaned, { overlapThreshold: 0.5 });
  assert.equal(ap.content, cleaned); // 未被采纳
  assert.ok(ap.aiNotes.includes('未采纳'));
  assert.equal(ap.kind, 'prompt');
  assert.deepEqual(ap.tags, ['翻译']);
});

test('护栏：高重叠时采纳 LLM content', () => {
  const cleaned = '请把下面这段中文翻译成英文，要求信达雅：{{text}}';
  const parsed = { kind: 'prompt', content: '请把下面这段中文翻译成英文，要求信达雅：{{text}}', title: 't' };
  const ap = applyExtraction(parsed, cleaned);
  assert.equal(ap.content, parsed.content);
  assert.equal(ap.aiNotes, '');
});

test('资源提取：保留官网信息，并拒绝不安全或低置信度链接', () => {
  const cleaned = '推荐使用 Notion 管理项目';
  const good = applyExtraction({ kind: 'resource', resource: { name: 'Notion', type: 'app', official_url: 'https://www.notion.so/', url_confidence: 0.95 }, content: cleaned }, cleaned);
  assert.equal(good.kind, 'resource');
  assert.equal(good.resource_name, 'Notion');
  assert.equal(good.resource_type, 'app');
  assert.equal(good.resource_url, 'https://www.notion.so/');
  assert.equal(good.resource_items[0].name, 'Notion');

  const guessed = applyExtraction({ kind: 'resource', resource: { name: 'Unknown', official_url: 'https://example.org', url_confidence: 0.2 } }, cleaned);
  assert.equal(guessed.kind, 'resource');
  assert.equal(guessed.resource_url, '');

  const unsafe = applyExtraction({ kind: 'resource', resource: { name: 'Bad', official_url: 'javascript:alert(1)', url_confidence: 1 } }, cleaned);
  assert.equal(unsafe.resource_url, '');

  const missingName = applyExtraction({ kind: 'resource', resource: { official_url: 'https://example.org', url_confidence: 1 } }, cleaned);
  assert.equal(missingName.kind, 'unknown');
});

test('资源提取：清单类 resource 提取多个子项链接', () => {
  const cleaned = 'UI 组件库清单：shadcn/ui 官网 ui.shadcn.com，Ant Design 官网 ant.design';
  const r = applyExtraction({
    kind: 'resource',
    resource: {
      name: 'UI 组件库清单', type: 'website',
      items: [
        { name: 'shadcn/ui', type: 'website', official_url: 'https://ui.shadcn.com/', url_confidence: 0.98 },
        { name: 'Ant Design', type: 'website', official_url: 'https://ant.design/', url_confidence: 0.98 },
        { name: '不确定的', type: 'website', official_url: 'https://maybe.example', url_confidence: 0.6 },
        { name: '没链接的', type: 'tool', official_url: '', url_confidence: 0.3 },
      ],
    },
    content: cleaned,
  }, cleaned);
  assert.equal(r.kind, 'resource');
  assert.equal(r.resource_items.length, 4);
  assert.deepEqual(r.resource_items.map((x) => x.url), ['https://ui.shadcn.com/', 'https://ant.design/', 'https://maybe.example/', '']);
  // 0.6 采纳但标 unsure；0.3 丢弃
  assert.deepEqual(r.resource_items.map((x) => x.unsure), [false, false, true, false]);
  // resource_url 取第一个有链接的
  assert.equal(r.resource_url, 'https://ui.shadcn.com/');
});

function mockFetch(impl) { return impl; }

test('LlmClient：json_object 失败后回退普通请求', async () => {
  const settings = { get: (k) => ({ llm_base_url: 'https://x', llm_api_key: 'k', llm_model: 'm', llm_timeout_ms: '5000', llm_temperature: '0' }[k] ?? '') };
  let calls = 0;
  const fetchImpl = mockFetch(async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    if (body.response_format) {
      return { ok: false, status: 400, text: async () => 'unsupported' };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  });
  const c = new LlmClient(settings, { fetchImpl });
  const r = await c.chat([{ role: 'user', content: 'hi' }], { json: true });
  assert.equal(calls, 2);
  assert.equal(r.content, '{"ok":true}');
});

test('LlmClient extract 返回解析后的对象', async () => {
  const settings = { get: (k) => ({ llm_base_url: 'https://x', llm_api_key: 'k', llm_model: 'm' }[k] ?? '0') };
  const fetchImpl = mockFetch(async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"kind":"prompt","title":"t"}\n```' } }] }),
  }));
  const c = new LlmClient(settings, { fetchImpl });
  const { parsed } = await c.extract('一段测试内容用于抽取');
  assert.equal(parsed.kind, 'prompt');
});
