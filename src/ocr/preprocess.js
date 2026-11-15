// 图像预处理：超长截图切片 + 重叠去重 + 超长边压缩。
// sharp 可选依赖，缺失时退化为不切片。

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch { /* sharp 不可用，跳过分片 */ }

export const SLICE_HEIGHT = 3000;    // 单片目标高度
export const OVERLAP = 200;          // 切片重叠像素
export const MAX_DIM = 8000;         // 单边最大
export const LONG_RATIO = 3;

export async function getMeta(buffer) {
  if (!sharp) return { width: 0, height: 0 };
  const m = await sharp(buffer).metadata();
  return { width: m.width || 0, height: m.height || 0 };
}

// 返回 [{buffer, offsetY}]；不需要切片时返回 [{buffer, offsetY:0}]
export async function prepareImage(buffer, mime) {
  if (!sharp) return [{ buffer, offsetY: 0 }];
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  let img = sharp(buffer);
  if (Math.max(w, h) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(w, h);
    const nw = Math.round(w * scale), nh = Math.round(h * scale);
    img = img.resize(nw, nh);
    return [{ buffer: await img.png().toBuffer(), offsetY: 0, resized: true }];
  }
  const isLong = h > SLICE_HEIGHT || (w > 0 && h / w > LONG_RATIO);
  if (!isLong) return [{ buffer, offsetY: 0 }];
  const slices = [];
  let y = 0;
  while (y < h) {
    const sh = Math.min(SLICE_HEIGHT, h - y);
    const part = await sharp(buffer).extract({ left: 0, top: y, width: w, height: sh }).png().toBuffer();
    slices.push({ buffer: part, offsetY: y });
    if (y + sh >= h) break;
    y += SLICE_HEIGHT - OVERLAP;
  }
  return slices;
}

// 拼接多片 OCR 文本，去掉重叠部分造成的重复行
export function mergeSliceTexts(texts) {
  if (!texts.length) return '';
  if (texts.length === 1) return texts[0];
  const out = texts[0].split('\n').filter(l => l.trim());
  for (let i = 1; i < texts.length; i++) {
    const lines = texts[i].split('\n').filter(l => l.trim());
    const existing = new Set(out.slice(-20)); // 重叠行只会出现在相邻边界附近
    for (const l of lines) {
      if (!existing.has(l)) out.push(l);
    }
    // 把新行也补进窗口
    for (const l of lines.slice(-20)) existing.add(l);
  }
  return out.join('\n');
}
