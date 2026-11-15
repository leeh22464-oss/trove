// 规则清洗：纯函数，不依赖任何外部服务。
// 输入原始文本，输出清洗后文本、被移除片段清单（含原因）、尾部 hashtag 候选。

const TRACKING_PARAMS = new Set([
  'spm', 'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'igsh',
  'share_token', 'xsec_token', 'xsec_source', 'xhsshare', 'share_source',
  'ref_src', 'ref_url', 'si', 'feature', 'buvid', 'vd_source',
  'share_medium', 'share_plat', 'share_tag', 'tt_from', 'utm_id', 'wfr',
]);

// 整行噪声短语：必须整行（允许首尾 emoji/装饰字符）匹配才删除，
// 避免误删正文中的「复制这段话」「请关注细节」。
const NOISE_LINE_PATTERNS = [
  /^(复制代码|copy code|copied!?|复制|拷贝)$/i,
  /^(重新生成|regenerate( response)?|continue generating|继续生成)$/i,
  /^(点赞|转发|收藏|关注|评论|打赏|投币|在看)$/,
  /^(阅读原文|展开全文|查看更多|查看全部|收起|show more|show less|read more|see more)$/i,
  /^(like|share|reply|repost|retweet|follow|subscribe|bookmark|comment)s?$/i,
  /^(广告|sponsored|promoted)$/i,
  /^分享到.*/,
  /^扫码.*/,
  /^长按.*(识别|二维码).*/,
  /^点击上方蓝字.*/,
  /^关注(公众号|博主|我)?[，,。.!！]?$/,
  /^(下载|打开)app.*/i,
  /^app内打开$/i,
  /^(\d+\s*)?(条)?(评论|回复|赞|转发)$/,
  /^(已复制|复制成功)$/,
  /^(编辑|删除|举报|屏蔽)$/,
];

// 互动计数行：纯数字+单位（1.2万 / 3.4K / 12）
const COUNT_LINE = /^[\d.,]+\s*(万|千|百|k|m|w|b)?$/i;
const TIMESTAMP_LINE = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}[:：]\d{2}(:\d{2})?|\d+\s*(秒|分钟|小时|天|周|个月|月|年)前|\d+\s*(s|m|h|d|w|mo|y)\s*ago|昨天|刚刚|今天)$/i;
// 社媒头部：@用户名 · 3h / 用户名 · 2024-01-01
const SOCIAL_HEADER = /^@?[\w一-龥_\-]{1,30}\s*[·•|]\s*(\d+\s*(s|m|h|d|w|秒|分钟|小时|天|周|个月|月|年)前?|\d{4}[-/]\d{1,2}[-/]\d{1,2})$/i;
const ROLE_PREFIX = /^(chatgpt said:|you said:|claude said:|claude:|assistant:|user:|human:|ai:|kimi:|gemini:|deepseek:|copilot:)\s*/i;
const HASHTAG = /#[^\s#]{1,40}#|#[\p{L}\p{N}_-]{1,40}/gu;
const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export function cleanText(raw, opts = {}) {
  const removed = [];
  const hashtagCandidates = [];
  if (!raw) return { cleaned: '', removed, hashtagCandidates };

  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[​‌‍﻿⁠⁡⁢⁣⁤]/g, '')
    .replace(/[       　]/g, ' ')
    .replace(/[ 	]+$/gm, '');

  // 提取 ``` 代码围栏，围栏内内容绝不动
  const fences = [];
  text = text.replace(/(`{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$)/g, (m) => {
    fences.push(m.replace(/\n$/, ''));
    return `\nFENCE_${fences.length - 1}\n`;
  });

  const roleLines = (text.match(/^(user|assistant|human|claude|ai):/gim) || []).length;
  const isChatCopy = /(chatgpt said:|you said:|claude said:)/i.test(text) || roleLines >= 2;

  const lines = text.split('\n');
  const out = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') { out.push(''); continue; }
    if (/^FENCE_\d+$/.test(trimmed)) { out.push(trimmed); continue; }

    const reason = noiseReason(trimmed);
    if (reason) { removed.push({ text: trimmed, reason }); continue; }

    let l = line;
    if (isChatCopy) {
      l = l.replace(ROLE_PREFIX, '');
    }
    l = stripTrackingUrls(l, removed);
    out.push(l);
  }

  // 清理末尾连续 hashtag 块：提取为候选标签
  while (out.length) {
    const last = out[out.length - 1];
    const t = last.trim();
    if (t === '') { out.pop(); continue; }
    const hashOnly = t.replace(HASHTAG, '').replace(/[\s|·,，、]+/g, '');
    if (hashOnly === '' && /#/.test(t)) {
      for (const m of t.matchAll(HASHTAG)) {
        const tag = m[0].replace(/^#+|#+$/g, '');
        if (tag) hashtagCandidates.unshift(tag);
      }
      removed.push({ text: t, reason: 'trailing_hashtags' });
      out.pop();
      continue;
    }
    break;
  }

  let cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  cleaned = cleaned.replace(/FENCE_(\d+)/g, (_, i) => '\n' + fences[+i] + '\n')
    .replace(/\n{3,}/g, '\n\n').trim();

  return { cleaned, removed, hashtagCandidates };
}

function noiseReason(t) {
  const bare = t
    .replace(/^[👍❤️🔁🔄📌⭐️⭐💬🗨️🔖✨➕🔥|·•\s]+/, '')
    .replace(/[👍❤️🔁🔄📌⭐️⭐💬🗨️🔖✨➕🔥|·•\s]+$/, '')
    .trim();
  if (!bare) return 'decoration';
  for (const re of NOISE_LINE_PATTERNS) {
    if (re.test(bare)) return 'ui_noise';
  }
  if (COUNT_LINE.test(bare)) return 'interaction_count';
  if (TIMESTAMP_LINE.test(bare)) return 'timestamp';
  if (SOCIAL_HEADER.test(bare)) return 'social_header';
  return null;
}

export function stripTrackingParams(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  let changed = false;
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
      u.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return url;
  let s = u.toString();
  if ([...u.searchParams.keys()].length === 0) s = s.replace(/\?/, '');
  return s;
}

function stripTrackingUrls(line, removed) {
  const result = line
    .replace(MD_LINK, (m, label, url) => {
      const stripped = stripTrackingParams(url);
      if (stripped !== url) removed.push({ text: url, reason: 'tracking_params' });
      return `[${label}](${stripped})`;
    });
  // 跳过已被 MD_LINK 消费过的 url：用占位替换太复杂，改为只对不紧跟 ]( 的裸 URL 处理
  return result.replace(URL_RE, (m, offset, str) => {
    // 若前一个字符是 '(' 则属于 markdown 链接，已处理
    if (offset > 0 && str[offset - 1] === '(') return m;
    const trailing = m.match(/[.,;:!?，。；：！？、]*$/)[0];
    const core = m.slice(0, m.length - trailing.length);
    const stripped = stripTrackingParams(core);
    if (stripped !== core) removed.push({ text: core, reason: 'tracking_params' });
    return stripped + trailing;
  });
}
