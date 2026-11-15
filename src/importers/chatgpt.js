// ChatGPT conversations.json 导入：mapping 树按 create_time 排序。
// 只抽取「用户发出的、像 prompt 的消息」作为候选。

export function parseChatgptExport(json) {
  const conversations = Array.isArray(json) ? json : [json];
  const sessions = [];
  for (const conv of conversations) {
    const mapping = conv.mapping || {};
    const nodes = Object.values(mapping)
      .map(n => n?.message)
      .filter(m => m && m.content && m.author);
    const msgs = nodes
      .map(m => ({
        role: m.author.role,
        text: extractText(m.content),
        time: m.create_time || 0,
      }))
      .filter(m => m.text && (m.role === 'user' || m.role === 'assistant'))
      .sort((a, b) => a.time - b.time);
    if (msgs.length) sessions.push({ title: conv.title || 'ChatGPT 对话', msgs, source: 'chatgpt' });
  }
  return sessions;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content.parts)) return content.parts.filter(p => typeof p === 'string').join('\n');
  return content.text || '';
}
