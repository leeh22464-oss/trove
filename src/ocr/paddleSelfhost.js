// 自建 PaddleX serving：POST {base}/ocr  {file:<base64>, fileType:1}
// 结果 result.ocrResults[]，容错提取 rec_texts。

function textsFromResult(result) {
  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { for (const x of node) visit(x, depth + 1); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.rec_texts)) {
      for (const t of node.rec_texts) {
        const s = typeof t === 'string' ? t : (t?.text ?? '');
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      }
    }
    for (const k of ['ocrResults', 'prunedResult', 'res', 'result']) {
      if (node[k]) visit(node[k], depth + 1);
    }
  };
  visit(result, 0);
  return out;
}

export function paddleSelfhost(settings, { fetchImpl = fetch } = {}) {
  return {
    name: 'paddle-selfhost',
    available() { return !!settings.get('paddle_selfhost_url'); },
    async extract(buffer, mime) {
      const base = (settings.get('paddle_selfhost_url') || 'http://localhost:8080').replace(/\/+$/, '');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const res = await fetchImpl(`${base}/ocr`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: buffer.toString('base64'), fileType: 1 }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`自建 OCR 失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('自建 OCR 返回非 JSON'); }
        const texts = textsFromResult(data?.result ?? data);
        return { text: texts.join('\n'), meta: { provider: 'selfhost' } };
      } finally { clearTimeout(timer); }
    },
    async test() {
      const base = (settings.get('paddle_selfhost_url') || 'http://localhost:8080').replace(/\/+$/, '');
      const res = await fetchImpl(`${base}/health`, { method: 'GET' }).catch(() => null);
      return { ok: res ? res.ok : false, note: res ? '' : '服务不可达（未启动 paddlex --serve 时正常）' };
    },
  };
}
