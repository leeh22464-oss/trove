// 真实校验 PaddleOCR 托管 API：node scripts/ocr-check.mjs <图片路径>
// token 从环境变量 CATCH_PADDLE_TOKEN 读取，不会打印。
import fs from 'node:fs';
import path from 'node:path';
import { paddleHosted } from '../src/ocr/paddleHosted.js';
import { DEFAULTS } from '../src/config.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('用法: node scripts/ocr-check.mjs <图片路径>'); process.exit(2); }
if (!process.env.CATCH_PADDLE_TOKEN) { console.error('未设置环境变量 CATCH_PADDLE_TOKEN'); process.exit(2); }

const settings = { get: (k) => (k === 'paddle_token' ? process.env.CATCH_PADDLE_TOKEN : process.env[`CATCH_${k.toUpperCase()}`] ?? DEFAULTS[k] ?? '') };
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'image/png';

const shape = (v, d = 0) => {
  if (Array.isArray(v)) return `[${v.length}] ${v.length ? shape(v[0], d + 1) : ''}`;
  if (v && typeof v === 'object') return d > 3 ? '{...}' : '{' + Object.entries(v).map(([k, x]) => `${k}: ${shape(x, d + 1)}`).join(', ') + '}';
  return typeof v;
};
const log = [];
const spy = async (url, opts) => {
  const res = await fetch(url, opts);
  const u = String(url).replace(/\?.*$/, '');
  const c = res.clone();
  const body = await c.text();
  const entry = { method: opts?.method || 'GET', url: u, status: res.status };
  try { entry.shape = shape(JSON.parse(body.split('\n').find(l => l.trim()))); } catch { entry.shape = body.slice(0, 120); }
  log.push(entry);
  return res;
};

const t0 = Date.now();
try {
  const r = await paddleHosted(settings, { fetchImpl: spy }).extract(fs.readFileSync(file), mime);
  console.log(`耗时 ${Date.now() - t0}ms，识别到 ${r.text.split('\n').filter(Boolean).length} 行文字`);
  console.log('---- 识别结果 ----\n' + (r.text || '(空：字段解析可能没对上，见下方响应结构)'));
} catch (e) {
  console.error('失败:', e.message);
}
console.log('\n---- 请求与响应结构（不含 token）----');
for (const e of log) console.log(`${e.method} ${e.url} -> ${e.status}\n  ${e.shape}`);
