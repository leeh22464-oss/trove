// OpenAI 兼容 LLM 客户端：JSON 输出 + 容错解析 + 防幻觉重叠校验。
// fetch 可注入，便于测试 mock。

export function tolerantJsonParse(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }
  // 尝试修补未闭合数组/对象（截断响应）
  if (first >= 0) {
    const frag = s.slice(first);
    try { return JSON.parse(frag + ']}'.repeat(1)); } catch {}
  }
  return null;
}

// token 级包含率：LLM content 中有多少 token 出现在 cleaned 里
export function overlapRatio(llmContent, cleaned) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const a = norm(llmContent), b = norm(cleaned);
  if (!a) return 0;
  if (!b) return a ? 0 : 1;
  // 用 4-gram 覆盖率（中文友好）
  const n = 4;
  let hit = 0, total = 0;
  for (let i = 0; i + n <= a.length; i += n) {
    total++;
    if (b.includes(a.slice(i, i + n))) hit++;
  }
  if (total === 0) return b.includes(a) ? 1 : 0;
  return hit / total;
}

// 反向覆盖率：cleaned 中有多少内容被 llmContent 覆盖（防 AI 只输出一小段）
export function coverageRatio(llmContent, cleaned) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const a = norm(llmContent), b = norm(cleaned);
  if (!b) return 1;
  if (!a) return 0;
  const n = 4;
  let hit = 0, total = 0;
  for (let i = 0; i + n <= b.length; i += n) {
    total++;
    if (a.includes(b.slice(i, i + n))) hit++;
  }
  if (total === 0) return a.includes(b) ? 1 : 0;
  return hit / total;
}

export const EXTRACT_SYSTEM = `你是一个内容整理助手，帮助用户把随手收集的文本整理成可复用的 prompt/skill 库条目。
严格按照 JSON 输出，不要输出任何其他内容。当文本在推荐、介绍或建议使用一个或多个网站、项目、应用或工具时，分类为 resource——既包括只讲一个资源的，也包括"清单/合集/盘点/推荐列表"这类列出一串资源的文本。普通顺带提及、作为例子的名字、prompt/skill 本身不要归为 resource。

链接规则：资源链接优先沿用原文里明确给出的官网/项目页（如"官网：xxx.com"、括号里的域名）；原文没给链接的，仅在你确实知道其官方域名/项目页时补全，不能猜测或编造，不确定时 url_confidence 给低分并留空 official_url。JSON 字段：
{
  "kind": "prompt|skill|snippet|note|resource|unknown",
  "title": "不超过40字的中文标题",
  "content": "去掉与本体无关的前后废话（作者寒暄、求点赞收藏、评论区、AI 的回答等）后的正文。**必须保留全部正文段落**——列表/步骤/分点内容一段都不能删，只删真正的噪声。保留原意，严禁改写 prompt 本身的内容。用 Markdown。",
  "summary": "一句话中文摘要，不超过60字",
  "tags": ["最多 N_TAGS 个标签，优先从下方已有标签中选择，确实没有合适的才新建，嵌套标签用 斜杠 分隔如 写作/润色"],
  "collection_hint": "建议归入的集合层级路径，用 斜杠 分层如 写作/提示词、AI/工程实践、求职/面试复盘；一级是大主题，二级是具体方向。下方给了已有集合树时优先复用其中的路径，不要造近义的新一级。可为空字符串",
  "variables": ["prompt 中出现的变量名列表，如 {{变量}}、[占位]、{变量}"],
  "target_models": ["适用模型，如 GPT-4o、Claude、Midjourney，可为空数组"],
  "removed_notes": "你删掉了哪些无关内容的简短说明",
  "is_prompt_confidence": 0.0到1.0,
  "lang": "zh|en|other",
  "resource": {
    "name": "整条资源的主名称；清单类可给清单主题名",
    "type": "website|project|app|tool",
    "official_url": "单个资源时其官网/项目页 https URL；清单类留空",
    "url_confidence": 0到1,
    "items": [ { "name": "清单里每个资源的名称", "type": "website|project|app|tool", "official_url": "该资源官网/项目页 URL，优先沿用原文给出的，没有且不确定就留空", "url_confidence": 0到1 } ]
  }
}`;

export function buildExtractMessages({ cleaned, relatedTags, maxTags = 5, customPrompt = '', collections = [] }) {
  const tagList = relatedTags.length
    ? relatedTags.map(t => `- ${t.name}${t.count ? `（用过 ${t.count} 次）` : ''}`).join('\n')
    : '（暂无已有标签）';
  // 集合树：列出 "父/子" 全路径，让 LLM 优先复用现有层级
  const nameOf = (id) => collections.find((c) => c.id === id)?.name;
  const fullPaths = collections.map((c) => c.parent_id ? `${nameOf(c.parent_id)}/${c.name}` : c.name);
  const colTree = fullPaths.length ? fullPaths.join('、') : '（暂无）';
  const user = [
    customPrompt ? `用户附加指令：${customPrompt}\n` : '',
    `已有标签（优先复用，不要造同义重复标签）：\n${tagList}\n`,
    `已有集合路径（collection_hint 优先从这里选，确实不合适才新建）：${colTree}\n`,
    `每条最多 ${maxTags} 个标签。\n`,
    `待整理文本：\n\`\`\`\n${cleaned}\n\`\`\``,
  ].join('\n');
  return [
    { role: 'system', content: EXTRACT_SYSTEM.replace('N_TAGS', String(maxTags)) },
    { role: 'user', content: user },
  ];
}

export class LlmClient {
  constructor(settings, { fetchImpl = fetch } = {}) {
    this.settings = settings;
    this.fetch = fetchImpl;
  }

  available() {
    return !!(this.settings.get('llm_base_url') && this.settings.get('llm_api_key') && this.settings.get('llm_model'));
  }

  async chat(messages, { temperature, json = true } = {}) {
    const base = this.settings.get('llm_base_url').replace(/\/+$/, '');
    const key = this.settings.get('llm_api_key');
    const model = this.settings.get('llm_model');
    const timeout = parseInt(this.settings.get('llm_timeout_ms')) || 30000;
    const temp = temperature ?? parseFloat(this.settings.get('llm_temperature') || '0.2');

    const body = { model, messages, temperature: temp, stream: false };
    const doReq = async (b) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await this.fetch(`${base}/chat/completions`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(b),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          const err = new Error(`LLM 请求失败 HTTP ${res.status}: ${t.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } finally { clearTimeout(timer); }
    };

    let data;
    if (json) {
      try {
        data = await doReq({ ...body, response_format: { type: 'json_object' } });
      } catch (e) {
        if (e.status === 400 || e.status === 422) data = await doReq(body);
        else throw e;
      }
    } else {
      data = await doReq(body);
    }
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { content, raw: data };
  }

  async extract(cleaned, { relatedTags = [], maxTags = 5, customPrompt = '', collections = [] } = {}) {
    const input = cleaned.length > 12000 ? cleaned.slice(0, 12000) + '\n\n[...已截断，原文过长]' : cleaned;
    const messages = buildExtractMessages({ cleaned: input, relatedTags, maxTags, customPrompt, collections });
    const { content } = await this.chat(messages, { json: true });
    const parsed = tolerantJsonParse(content);
    if (!parsed) throw new Error('LLM 返回无法解析为 JSON');
    return { parsed, truncated: cleaned.length > 12000 };
  }

  async test() {
    const t0 = Date.now();
    const { content } = await this.chat([{ role: 'user', content: '回复"ok"两个字母即可' }], { json: false });
    return { ok: true, latencyMs: Date.now() - t0, sample: String(content).slice(0, 100) };
  }
}

// 应用 LLM 结果到条目：带防幻觉校验
export function applyExtraction(parsed, cleaned, { overlapThreshold = 0.5 } = {}) {
  const out = {
    kind: 'unknown', title: '', content: cleaned, summary: '',
    tags: [], collection_hint: '', variables: [], target_models: [],
    removed_notes: '', is_prompt_confidence: 0, lang: '', aiNotes: '',
  };
  if (!parsed || typeof parsed !== 'object') return out;
  const kinds = new Set(['prompt', 'skill', 'snippet', 'note', 'resource', 'unknown']);
  out.kind = kinds.has(parsed.kind) ? parsed.kind : 'unknown';
  const resource = parsed.resource && typeof parsed.resource === 'object' ? parsed.resource : {};
  const sanitize = (entry) => {
    const name = String(entry?.name || '').trim().slice(0, 120);
    const type = ['website', 'project', 'app', 'tool'].includes(entry?.type) ? entry.type : '';
    const confidence = Number(entry?.url_confidence) || 0;
    let url = '';
    // ≥0.5 采纳 URL（0.5–0.7 标为待确认），<0.5 丢弃防编造
    if (name && confidence >= 0.5) {
      try {
        const u = new URL(String(entry?.official_url || '').trim());
        if (['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.') && !u.username && !u.password) {
          u.hash = '';
          url = u.href.slice(0, 2048);
        }
      } catch { }
    }
    return { name, type, url, confidence, unsure: !!url && confidence < 0.7 };
  };
  out.resource_name = String(resource.name || '').trim().slice(0, 120);
  out.resource_type = ['website', 'project', 'app', 'tool'].includes(resource.type) ? resource.type : '';
  // 资源列表：清单类有 items，单资源回退用顶层字段
  const rawItems = Array.isArray(resource.items) ? resource.items : [];
  const items = rawItems.map(sanitize).filter((r) => r.name).slice(0, 60);
  const top = sanitize(resource);
  out.resource_url_confidence = top.confidence;
  if (!items.length && top.name) items.push(top);
  out.resource_items = items;
  out.resource_url = items[0]?.url || top.url || '';
  if (out.kind === 'resource' && !(out.resource_name || items.length)) out.kind = 'unknown';
  out.title = String(parsed.title || '').slice(0, 40);
  out.summary = String(parsed.summary || '').slice(0, 300);
  out.tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 10) : [];
  out.collection_hint = String(parsed.collection_hint || '');
  out.variables = Array.isArray(parsed.variables) ? parsed.variables.map(String) : [];
  out.target_models = Array.isArray(parsed.target_models) ? parsed.target_models.map(String) : [];
  out.removed_notes = String(parsed.removed_notes || '');
  out.is_prompt_confidence = Number(parsed.is_prompt_confidence) || 0;
  out.lang = String(parsed.lang || '');

  const llmContent = typeof parsed.content === 'string' ? parsed.content : '';
  const ratio = overlapRatio(llmContent, cleaned);
  const coverage = coverageRatio(llmContent, cleaned);
  // 双向校验：AI 输出要和原文重叠（防幻觉）+ 覆盖原文 ≥40%（防 AI 只输出一小段截断正文）
  if (llmContent && ratio >= overlapThreshold && coverage >= 0.4) {
    out.content = llmContent;
  } else if (llmContent) {
    out.aiNotes = `AI 精简未采纳（重叠率 ${(ratio * 100).toFixed(0)}%，覆盖率 ${(coverage * 100).toFixed(0)}%）`;
  }
  return out;
}
