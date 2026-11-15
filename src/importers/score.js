// 「像 prompt」的启发式打分：长度、角色设定、指令性、变量、结构化。
export function promptScore(text) {
  const t = String(text || '');
  let score = 0;
  const len = t.length;
  if (len >= 30) score += 1;
  if (len >= 80) score += 1;
  if (len >= 200) score += 1;
  if (len > 4000) score -= 1;
  if (/(你是|扮演|作为|act as|you are|role|人设)/i.test(t)) score += 2;
  if (/(请|要求|需要|步骤|输出|格式|规则|必须|不要|约束)/.test(t)) score += 1;
  if (/(\{\{[^}]+\}\}|\[[^\]]{1,30}\]|\{[a-zA-Z_][\w]{1,30}\}|<[a-z_]+>)/i.test(t)) score += 2;
  const structure = (t.match(/^[\s]*[-*•#>\d.]/gm) || []).length;
  if (structure >= 2) score += 1;
  if (/(prompt|提示词|system prompt|指令)/i.test(t)) score += 1;
  return Math.max(0, score);
}

// 从对话 session 中抽取用户消息候选
export function candidatesFromSessions(sessions) {
  const out = [];
  for (const s of sessions) {
    for (let i = 0; i < s.msgs.length; i++) {
      const m = s.msgs[i];
      if (m.role !== 'user') continue;
      const text = m.text.trim();
      if (!text || text.length < 15) continue;
      const score = promptScore(text);
      if (score < 3) continue;
      const context = s.msgs.slice(Math.max(0, i - 2), Math.min(s.msgs.length, i + 3));
      out.push({
        title: s.title,
        source: s.source,
        text,
        score,
        context,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
