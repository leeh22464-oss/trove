// OCR provider 链：按配置优先级依次尝试，失败/空结果降级到下一个。
import { paddleHosted } from './paddleHosted.js';
import { paddleSelfhost } from './paddleSelfhost.js';
import { visionLlm } from './visionLlm.js';

export const PROVIDERS = {
  'paddle-hosted': paddleHosted,
  'paddle-selfhost': paddleSelfhost,
  'vision-llm': visionLlm,
};

export function createOcrChain(settings, { fetchImpl = fetch } = {}) {
  const order = String(settings.get('ocr_chain') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const chain = order
    .map(name => {
      const make = PROVIDERS[name];
      return make ? make(settings, { fetchImpl }) : null;
    })
    .filter(Boolean);

  return {
    providers: chain,
    anyAvailable() {
      return chain.some(p => { try { return p.available(); } catch { return false; } });
    },
    async extract(buffer, mime) {
      const errors = [];
      for (const p of chain) {
        try {
          if (!p.available()) { errors.push(`${p.name}: 未配置`); continue; }
          const r = await p.extract(buffer, mime);
          if (r && (r.text || r.vision_desc)) return { ...r, provider: p.name };
          errors.push(`${p.name}: 空结果`);
        } catch (e) {
          errors.push(`${p.name}: ${e.message}`);
        }
      }
      if (!errors.length) errors.push('没有可用的 OCR provider');
      throw new Error(errors.join('；'));
    },
    async testAll() {
      const results = [];
      for (const p of chain) {
        try {
          if (!p.available()) { results.push({ name: p.name, ok: false, error: '未配置' }); continue; }
          const t0 = Date.now();
          const r = await p.test ? await p.test() : { ok: true };
          results.push({ name: p.name, ok: true, latencyMs: Date.now() - t0, ...r });
        } catch (e) {
          results.push({ name: p.name, ok: false, error: e.message });
        }
      }
      return results;
    },
  };
}
