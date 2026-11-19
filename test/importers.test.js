import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatgptExport } from '../src/importers/chatgpt.js';
import { parseClaudeExport } from '../src/importers/claude.js';
import { parseTranscript } from '../src/importers/transcript.js';
import { candidatesFromSessions, promptScore } from '../src/importers/score.js';
import { parseMarkdownFile } from '../src/importers/obsidian.js';

test('ChatGPT mapping 树解析按 create_time 排序', () => {
  const conv = [{
    title: 'test',
    mapping: {
      a: { message: { author: { role: 'user' }, content: { parts: ['问题2'] }, create_time: 200 } },
      b: { message: { author: { role: 'assistant' }, content: { parts: ['回答1'] }, create_time: 150 } },
      c: { message: { author: { role: 'user' }, content: { parts: ['问题1'] }, create_time: 100 } },
      d: { message: { author: { role: 'system' }, content: { parts: ['skip'] }, create_time: 50 } },
    },
  }];
  const sessions = parseChatgptExport(conv);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].msgs.map(m => m.text), ['问题1', '回答1', '问题2']);
});

test('Claude chat_messages sender 解析', () => {
  const conv = [{ name: 'c', chat_messages: [
    { sender: 'human', text: '你好', created_at: '2024-01-02T00:00:00Z' },
    { sender: 'assistant', text: '您好', created_at: '2024-01-01T00:00:00Z' },
  ]}];
  const sessions = parseClaudeExport(conv);
  assert.equal(sessions[0].msgs[0].role, 'assistant');
  assert.equal(sessions[0].msgs[1].role, 'user');
});

test('纯文本转录识别中英文角色', () => {
  const t = `User: 问题一\nAssistant: 回答一\n用户：问题二\n助手：回答二\n我：问题三\nAI：回答三\nHuman: q4\nAssistant: a4`;
  const sessions = parseTranscript(t);
  const msgs = sessions[0].msgs;
  assert.equal(msgs.filter(m => m.role === 'user').length, 4);
  assert.equal(msgs.filter(m => m.role === 'assistant').length, 4);
});

test('promptScore 高分给像 prompt 的消息', () => {
  const high = promptScore('你是一位资深翻译家，请把下面的文字翻译成英文，要求信达雅：\n1. 保持语气\n2. {{text}}');
  const low = promptScore('好的');
  assert.ok(high >= 5);
  assert.ok(low < 3);
});

test('candidatesFromSessions 只抽 user 消息且过滤低分', () => {
  const sessions = [{ title: 's', source: 'test', msgs: [
    { role: 'user', text: '你是一位资深编辑，请润色下面的文字，要求：\n1. 保持原意\n2. 语言流畅\n3. {{text}}' },
    { role: 'assistant', text: '很长很长的回答，不应该被抽取为 prompt 候选，因为它是 AI 说的' },
    { role: 'user', text: '嗯' },
  ]}];
  const cands = candidatesFromSessions(sessions);
  assert.equal(cands.length, 1);
  assert.ok(cands[0].text.includes('资深编辑'));
});

test('obsidian 解析 frontmatter/tags/wikilinks', () => {
  const md = `---\ntitle: 测试\n---\n正文 #tag1 链接 [[另一篇]] 和 [[第三|别名]]`;
  const r = parseMarkdownFile(md);
  assert.equal(r.title, '测试');
  assert.ok(r.tags.includes('tag1'));
  assert.ok(r.wikilinks.includes('另一篇'));
  assert.ok(r.wikilinks.includes('第三'));
});
