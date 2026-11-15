// 通用纯文本转录识别：User:/Assistant:、用户：/助手：、我：/AI：、Human:/Assistant:

const ROLE_RE = /^(user|assistant|human|ai|chatgpt|claude|gemini|deepseek|kimi|用户|助手|我|问|答)\s*[:：]\s*/i;
const USER_SET = new Set(['user', 'human', '用户', '我', '问']);
const ASSISTANT_SET = new Set(['assistant', 'ai', 'chatgpt', 'claude', 'gemini', 'deepseek', 'kimi', '助手', '答']);

export function parseTranscript(text) {
  const lines = String(text || '').split('\n');
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(ROLE_RE);
    if (m) {
      if (cur) msgs.push(cur);
      const tag = m[1].toLowerCase();
      const role = USER_SET.has(tag) ? 'user' : (ASSISTANT_SET.has(tag) ? 'assistant' : null);
      cur = role ? { role, text: line.slice(m[0].length) } : { role: 'user', text: line };
      if (!role) cur.text = line;
    } else if (cur) {
      cur.text += '\n' + line;
    } else {
      cur = { role: 'user', text: line };
    }
  }
  if (cur) msgs.push(cur);
  const filtered = msgs.filter(m => m.text.trim());
  return filtered.length ? [{ title: '文本转录', msgs: filtered, source: 'transcript' }] : [];
}
