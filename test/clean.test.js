import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, stripTrackingParams } from '../src/clean.js';

test('去除 UI 噪声行', () => {
  const { cleaned, removed } = cleanText('好内容\n复制代码\n复制\n点赞\n转发\n阅读原文\n展开全文\nShow more\nLike\nSponsored');
  assert.equal(cleaned, '好内容');
  assert.ok(removed.length >= 5);
  assert.ok(removed.every(r => r.reason === 'ui_noise'));
});

test('代码围栏内容不变', () => {
  const raw = '上文\n```\n复制\n点赞\n1.2万\n```\n下文';
  const { cleaned } = cleanText(raw);
  assert.ok(cleaned.includes('```\n复制\n点赞\n1.2万\n```'));
});

test('尾部 hashtag 块提取为候选', () => {
  const { cleaned, hashtagCandidates, removed } = cleanText('正文内容\n#写作 #prompt #AI');
  assert.equal(cleaned, '正文内容');
  assert.deepEqual(hashtagCandidates.sort(), ['AI', 'prompt', '写作']);
  assert.ok(removed.some(r => r.reason === 'trailing_hashtags'));
});

test('微博风格双井 hashtag', () => {
  const { hashtagCandidates } = cleanText('内容\n#话题一# #话题二#');
  assert.ok(hashtagCandidates.includes('话题一'));
});

test('URL 追踪参数清理', () => {
  assert.equal(stripTrackingParams('https://x.com/a?utm_source=t&b=1&utm_medium=m'), 'https://x.com/a?b=1');
  const { cleaned, removed } = cleanText('看 https://example.com/p?spm=abc&id=5');
  assert.ok(cleaned.includes('https://example.com/p?id=5'));
  assert.ok(removed.some(r => r.reason === 'tracking_params'));
});

test('互动计数行去除', () => {
  const { removed } = cleanText('内容\n1.2万\n3.4K\n42');
  const counts = removed.filter(r => r.reason === 'interaction_count');
  assert.equal(counts.length, 3);
});

test('时间戳与社媒头部', () => {
  const { removed } = cleanText('内容\n@user · 3h\n2024-01-15\n3小时前');
  assert.ok(removed.some(r => r.reason === 'social_header'));
  assert.ok(removed.some(r => r.reason === 'timestamp'));
});

test('聊天复制的角色前缀（仅在判定为聊天复制时）', () => {
  const { cleaned } = cleanText('ChatGPT said:\n这是回答\nYou said:\n这是问题');
  assert.ok(!cleaned.includes('ChatGPT said:'));
  assert.ok(cleaned.includes('这是回答'));
});

test('非聊天文本不误删前缀', () => {
  const { cleaned } = cleanText('assistant: 注意这里的冒号是内容的一部分，不是聊天记录');
  assert.ok(cleaned.includes('assistant:'));
});

test('不误删正文中的危险词（反例）', () => {
  const r1 = cleanText('复制这段话发给你的朋友\n请关注细节\n分享是一种美德');
  assert.ok(r1.cleaned.includes('复制这段话'));
  assert.ok(r1.cleaned.includes('请关注细节'));
  assert.ok(r1.cleaned.includes('分享是一种美德'));
});

test('折叠 3+ 空行', () => {
  const { cleaned } = cleanText('a\n\n\n\n\nb');
  assert.equal(cleaned, 'a\n\nb');
});

test('零宽字符清理', () => {
  const { cleaned } = cleanText('a​b﻿c');
  assert.equal(cleaned, 'abc');
});

test('removed 有 text 和 reason', () => {
  const { removed } = cleanText('内容\n复制\n1.2万');
  for (const r of removed) {
    assert.ok(r.text);
    assert.ok(r.reason);
  }
});
