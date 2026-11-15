// Claude 导出的 conversations.json：chat_messages 含 sender + text。

export function parseClaudeExport(json) {
  const conversations = Array.isArray(json) ? json : [json];
  const sessions = [];
  for (const conv of conversations) {
    const msgs = (conv.chat_messages || [])
      .map(m => ({
        role: m.sender === 'human' ? 'user' : (m.sender === 'assistant' ? 'assistant' : m.sender),
        text: extractText(m),
        time: m.created_at ? Date.parse(m.created_at) / 1000 : 0,
      }))
      .filter(m => m.text && (m.role === 'user' || m.role === 'assistant'))
      .sort((a, b) => a.time - b.time);
    if (msgs.length) sessions.push({ title: conv.name || conv.title || 'Claude 对话', msgs, source: 'claude' });
  }
  return sessions;
}

function extractText(m) {
  if (typeof m.text === 'string' && m.text) return m.text;
  if (Array.isArray(m.content)) {
    return m.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  }
  return '';
}
