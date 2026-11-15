// 百度 AI Studio 托管 PaddleOCR API（异步任务：提交 → 轮询 → 下载 JSONL）。
// 协议按官方 SDK 源码核实：
//   POST {base}/api/v2/ocr/jobs  multipart(file, model, optionalPayload) 或 JSON(fileUrl)
//     → { code:0, data:{ jobId } }
//   GET {base}/api/v2/ocr/jobs/{jobId} → data.state: pending|running|done|failed
//   done → data.resultUrl.jsonUrl 为 JSONL，每行一个 result 对象
// 结果字段为容错解析：兼容 result.ocrResults[].prunedResult.rec_texts / res / 顶层 rec_texts。

function textsFromResult(result) {
  const out = [];
  const seen = new WeakSet();
  const pushArr = (arr) => {
    if (!Array.isArray(arr) || seen.has(arr)) return;
    seen.add(arr);
    for (const t of arr) {
      const s = typeof t === 'string' ? t : (t?.text ?? t?.rec_text ?? '');
      if (s) out.push(s);
    }
  };
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { for (const x of node) visit(x, depth + 1); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.rec_texts)) pushArr(node.rec_texts);
    for (const k of ['ocrResults', 'prunedResult', 'res', 'result', 'layout_det_res', 'overall_ocr_res']) {
      if (node[k]) visit(node[k], depth + 1);
    }
  };
  visit(result, 0);
  return out;
}

export function paddleHosted(settings, { fetchImpl = fetch } = {}) {
  return {
    name: 'paddle-hosted',
    available() { return !!settings.get('paddle_token'); },
    async test() { return { note: '仅检查了 token 是否已填写，未发起请求；请用 scripts/ocr-check.mjs 真实验证' }; },
    async extract(buffer, mime) {
      const base = (settings.get('paddle_base_url') || 'https://paddleocr.aistudio-app.com').replace(/\/+$/, '');
      const token = settings.get('paddle_token');
      const model = settings.get('paddle_model') || 'PP-OCRv5';
      const pollMs = parseInt(settings.get('paddle_poll_interval_ms')) || 2000;
      const timeoutMs = parseInt(settings.get('paddle_poll_timeout_ms')) || 120000;
      const headers = { Authorization: `bearer ${token}` };
      // 每个请求单独超时：连接卡住时不能无限等待（否则整个任务队列被堵死）
      const reqMs = parseInt(settings.get('paddle_request_timeout_ms')) || 30000;
      const fetchT = (u, opts = {}) => fetchImpl(u, { ...opts, signal: AbortSignal.timeout(reqMs) });

      const fd = new FormData();
      fd.append('model', model);
      fd.append('optionalPayload', JSON.stringify({ useDocOrientationClassify: false, useDocUnwarping: false, useTextlineOrientation: false }));
      fd.append('file', new Blob([buffer], { type: mime || 'image/png' }), 'image.png');

      const submit = await fetchT(`${base}/api/v2/ocr/jobs`, { method: 'POST', headers, body: fd });
      const submitText = await submit.text();
      if (!submit.ok) throw new Error(`Paddle 提交失败 HTTP ${submit.status}: ${submitText.slice(0, 300)}`);
      let submitData;
      try { submitData = JSON.parse(submitText); } catch { throw new Error('Paddle 提交返回非 JSON'); }
      const jobId = submitData?.data?.jobId;
      if (!jobId) throw new Error(`Paddle 提交缺少 jobId: ${submitText.slice(0, 200)}`);

      const deadline = Date.now() + timeoutMs;
      let resultUrl;
      for (;;) {
        if (Date.now() > deadline) throw new Error('Paddle 任务超时');
        await new Promise(r => setTimeout(r, pollMs));
        const st = await fetchT(`${base}/api/v2/ocr/jobs/${jobId}`, { headers });
        const stText = await st.text();
        if (!st.ok) throw new Error(`Paddle 轮询失败 HTTP ${st.status}: ${stText.slice(0, 200)}`);
        let sd;
        try { sd = JSON.parse(stText); } catch { throw new Error('Paddle 轮询返回非 JSON'); }
        const state = sd?.data?.state;
        if (state === 'done' || state === 'finished' || state === 'success') {
          resultUrl = sd?.data?.resultUrl?.jsonUrl || sd?.data?.result_url?.json_url;
          if (!resultUrl) throw new Error('Paddle done 但缺少 resultUrl.jsonUrl');
          break;
        }
        if (state === 'failed' || state === 'error') {
          throw new Error(`Paddle 任务失败: ${sd?.data?.error || sd?.data?.message || stText.slice(0, 200)}`);
        }
        // pending / running → 继续
      }

      const dl = await fetchT(resultUrl);
      if (!dl.ok) throw new Error(`Paddle 结果下载失败 HTTP ${dl.status}`);
      const jsonl = await dl.text();
      const texts = [];
      for (const line of jsonl.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          texts.push(...textsFromResult(row?.result ?? row));
        } catch { /* 容错跳过坏行 */ }
      }
      return { text: texts.join('\n'), meta: { jobId, model } };
    },
  };
}
