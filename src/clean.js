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
  /^置顶评论$/,
  /^评论\s*\d+$/,
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
// 评论区起始标记：截断其后全部内容（社媒/社区抓取的评论串混进正文）
const COMMENT_BLOCK = /(共\s*\d+\s*条评论|查看全部\s*\d+\s*条评论|全部评论|评论区)[^\n]*/;
// 评论行模式：用户名 回复 用户名 : ...（多条连续出现即评论区）
const COMMENT_LINE = /^[\w一-龥_\-·]{1,20}\s+回复\s+[\w一-龥_\-·]{1,20}\s*[:：]/;
// 评论尾巴：日期+地区+数字（可选「回复」）+用户名（如「10-11广东 9260 回复  瑜驾亲征 斌临城下」）
const COMMENT_META = /\d{1,2}[-/]\d{1,2}\s*[\u4e00-\u9fa5]{2,4}\s+[\d.,万]+\s*(回复\s+)?[\w一-龥_\-·]{2,20}(?:\s+[\w一-龥_\-·]{2,20})*/g;
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

  // 评论区截断：正文里混入「共 N 条评论 / 评论区」后，其后内容整体丢弃
  const cb = cleaned.search(COMMENT_BLOCK);
  if (cb > -1) {
    removed.push({ text: cleaned.slice(cb, Math.min(cb + 60, cleaned.length)) + '…', reason: 'comment_block' });
    cleaned = cleaned.slice(0, cb);
    // 评论块前的「日期+地区」短尾（如「10-20 江苏」）一并去掉
    cleaned = cleaned.replace(/\s*\d{1,2}[-/]\d{1,2}\s*[\u4e00-\u9fa5]{2,4}\s*$/, '');
  }
  // 连续评论行（社媒评论串挤一行时按「名字 回复 名字 :」切分，从首个评论块起截断）
  const cl = cleaned.search(new RegExp(`[^\\n]*${COMMENT_LINE.source.slice(1)}`));
  if (cl > -1 && (cleaned.slice(cl).match(/回复\s+[\w一-龥_\-·]{1,20}\s*[:：]/g) || []).length >= 2) {
    removed.push({ text: cleaned.slice(cl, Math.min(cl + 60, cleaned.length)) + '…', reason: 'comment_block' });
    cleaned = cleaned.slice(0, cl);
  }
  // 正文中间的社媒互动数据尾巴（如「10-11广东 9260 回复 用户名」）——出现 2+ 次时逐个删除，不截断
  const metaMatches = cleaned.match(COMMENT_META) || [];
  if (metaMatches.length >= 2) {
    removed.push({ text: metaMatches.slice(0, 3).join(' / ') + '…', reason: 'comment_block' });
    cleaned = cleaned.replace(COMMENT_META, ' ');
    // 「置顶评论」标记一并删除
    cleaned = cleaned.replace(/置顶评论\s*/g, '');
  }

  cleaned = cleaned.replace(/FENCE_(\d+)/g, (_, i) => '\n' + fences[+i] + '\n')
    .replace(/\n{3,}/g, '\n\n').trim();

  // 中文数字列表转 markdown 有序列表：「1，」「2，」→换行+「1.」「2.」让 marked 渲染成列表
  cleaned = cleaned.replace(/\s*(\d+)，/g, '\n\n$1. ').replace(/^\s*(\d+)\. /m, '$1. ');

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
