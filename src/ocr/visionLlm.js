// vision-llm：OpenAI 兼容多模态 OCR。逐字转录 + 可选图片描述。

const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export function visionLlm(settings, { fetchImpl = fetch } = {}) {
  const available = () => !!(settings.get('llm_base_url') && settings.get('llm_api_key') && settings.get('llm_model'));
  const call = async (buffer, mime) => {
    const base = settings.get('llm_base_url').replace(/\/+$/, '');
    const timeout = parseInt(settings.get('llm_timeout_ms')) || 30000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout * 2);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.get('llm_api_key')}` },
        body: JSON.stringify({
          model: settings.get('llm_model'),
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请逐字转录图片中的全部文字，保持阅读顺序，不要解释、不要翻译、不要添加描述。如果图片中没有文字，输出图片描述（用于检索），格式：DESC: <描述>' },
              { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${buffer.toString('base64')}` } },
            ],
          }],
          temperature: 0,
          stream: false,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`vision LLM 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('vision LLM 返回非 JSON'); }
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (typeof content !== 'string') return { text: '', vision_desc: '' };
      if (content.startsWith('DESC:')) return { text: '', vision_desc: content.slice(5).trim() };
      return { text: content.trim(), vision_desc: '' };
    } finally { clearTimeout(timer); }
  };
  return {
    name: 'vision-llm',
    available,
    extract: call,
    async test() { return call(TEST_PNG, 'image/png'); },
  };
}
