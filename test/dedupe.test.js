import test from 'node:test';
import assert from 'node:assert/strict';
import { memStore } from './helpers.js';
import { normalizeUrl, contentHash, simhash, hamming, jaccard, findDuplicates } from '../src/dedupe.js';

test('URL 规范化：追踪参数、www、大小写、尾斜杠', () => {
  assert.equal(normalizeUrl('https://www.X.com/a/?utm_source=t#f'), 'https://x.com/a');
  assert.equal(normalizeUrl('https://x.com/a?utm_medium=m'), 'https://x.com/a');
  assert.equal(normalizeUrl('https://twitter.com/a'), 'https://x.com/a');
});

test('hash 精确去重', () => {
  const s = memStore();
  const h = contentHash('内容');
  s.db.prepare("INSERT INTO items(title,content,content_hash) VALUES('t','内容',?)").run(h);
  const r = findDuplicates(s.db, { contentHash: h });
  assert.equal(r.exact.length, 1);
});

test('URL 规范化后算重复', () => {
  const s = memStore();
  s.db.prepare("INSERT INTO items(title,source_url) VALUES('t','https://x.com/a?utm_source=t')").run();
  const r = findDuplicates(s.db, { url: 'https://x.com/a' });
  assert.equal(r.exact.length, 1);
  assert.equal(r.exact[0].via, 'url');
});

test('simhash 近似重复', () => {
  const a = simhash('这是一段比较长的中文文本，用来测试近似重复检测是否工作正常。');
  const b = simhash('这是一段比较长的中文文本，用来测试近似重复检测是否工作正常呀。');
  const c = simhash('完全不同的另一段文本内容哦');
  assert.ok(hamming(a, b) <= 6);
  assert.ok(hamming(a, c) > 10);
});

test('jaccard', () => {
  assert.ok(jaccard('abcdefghij', 'abcdefghxj') > 0.5);
  assert.ok(jaccard('abcdefg', '1234567') < 0.1);
});
