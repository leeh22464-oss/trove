import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrChain } from '../src/ocr/index.js';
import { paddleHosted } from '../src/ocr/paddleHosted.js';
import { mergeSliceTexts } from '../src/ocr/preprocess.js';

const settings = (vals = {}) => ({ get: (k) => vals[k] ?? '' });

function provider(name, { available = true, result = null, fail = false }) {
  return {
    name,
    available: () => available,
    async extract() {
      if (fail) throw new Error(`${name} boom`);
      return result;
    },
  };
}

test('provider 链：第一个失败降级到下一个', async () => {
  const { paddleHosted: p1, paddleSelfhost: p2, visionLlm: p3 } = { paddleHosted, paddleSelfhost: null, visionLlm: null };
  // 直接构造链：用内部 PROVIDERS 替换太麻烦，改为手动验证 createOcrChain 逻辑
  const st = settings({ ocr_chain: 'paddle-selfhost,vision-llm', paddle_selfhost_url: 'http://x', llm_base_url: 'b', llm_api_key: 'k', llm_model: 'm' });
  let n = 0;
  const fetchImpl = async (url, opts) => {
    n++;
    if (url.includes('/ocr')) return { ok: false, status: 500, text: async () => 'err' };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '识别文字' } }] }) };
  };
  const chain = createOcrChain(st, { fetchImpl });
  const r = await chain.extract(Buffer.from('x'), 'image/png');
  assert.equal(r.text, '识别文字');
  assert.equal(r.provider, 'vision-llm');
});

test('provider 链：空结果视为失败降级', async () => {
  const st = settings({ ocr_chain: 'paddle-selfhost,vision-llm', paddle_selfhost_url: 'http://x', llm_base_url: 'b', llm_api_key: 'k', llm_model: 'm' });
  const fetchImpl = async (url) => {
    if (url.includes('/ocr')) return { ok: true, text: async () => JSON.stringify({ result: { ocrResults: [] } }) };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'fallback 文字' } }] }) };
  };
  const chain = createOcrChain(st, { fetchImpl });
  const r = await chain.extract(Buffer.from('x'), 'image/png');
  assert.equal(r.provider, 'vision-llm');
});

test('都不可用时报错列出原因', async () => {
  const st = settings({ ocr_chain: 'paddle-hosted' });
  const chain = createOcrChain(st);
  await assert.rejects(() => chain.extract(Buffer.from('x'), 'image/png'), /未配置/);
});

test('paddle hosted 状态机 pending→running→done + JSONL 解析', async () => {
  const st = settings({ paddle_token: 'tok', paddle_base_url: 'https://api.test', paddle_model: 'PP-OCRv5', paddle_poll_interval_ms: '1', paddle_poll_timeout_ms: '5000' });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (opts?.method === 'POST') {
      assert.equal(opts.headers.Authorization, 'bearer tok');
      return { ok: true, text: async () => JSON.stringify({ code: 0, data: { jobId: 'job1' } }) };
    }
    if (url.endsWith('/job1')) {
      const n = calls.filter(c => c.endsWith('/job1')).length;
      if (n === 1) return { ok: true, text: async () => JSON.stringify({ data: { state: 'pending' } }) };
      if (n === 2) return { ok: true, text: async () => JSON.stringify({ data: { state: 'running' } }) };
      return { ok: true, text: async () => JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: 'https://api.test/result.jsonl' } } }) };
    }
    if (url.endsWith('result.jsonl')) {
      return { ok: true, text: async () => '{"result":{"ocrResults":[{"prunedResult":{"rec_texts":["第一行","第二行","第二行"]}}]}}\n{"result":{"ocrResults":[{"prunedResult":{"rec_texts":["第三行"]}}]}}' };
    }
    throw new Error('unexpected ' + url);
  };
  const p = paddleHosted(st, { fetchImpl });
  const r = await p.extract(Buffer.from('img'), 'image/png');
  assert.equal(r.text, '第一行\n第二行\n第二行\n第三行');
});

test('paddle hosted failed 状态抛错', async () => {
  const st = settings({ paddle_token: 'tok', paddle_base_url: 'https://api.test', paddle_poll_interval_ms: '1' });
  const fetchImpl = async (url, opts) => {
    if (opts?.method === 'POST') return { ok: true, text: async () => JSON.stringify({ data: { jobId: 'j' } }) };
    return { ok: true, text: async () => JSON.stringify({ data: { state: 'failed', error: 'quota' } }) };
  };
  await assert.rejects(() => paddleHosted(st, { fetchImpl }).extract(Buffer.from('x'), 'image/png'), /失败/);
});

test('mergeSliceTexts 去重叠行', () => {
  const t = mergeSliceTexts(['a\nb\nc\nd', 'c\nd\ne\nf', 'g']);
  assert.equal(t, 'a\nb\nc\nd\ne\nf\ng');
});
