import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const icon = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="/img/icons.svg#i-${name}"/></svg>`;

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('无法连接到服务，请确认 catch 仍在运行'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}
export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});
export const patch = (url, body) => api('PATCH', url, body ?? {});
export const put = (url, body) => api('PUT', url, body ?? {});

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
});
export function renderMd(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? '')), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'], FORBID_ATTR: ['style'] });
}

export function markdownToText(text) {
  const root = document.createElement('div');
  root.innerHTML = renderMd(text);
  const blocks = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV']);
  const walk = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n';
    if (tag === 'IMG') return node.alt || '';
    if (tag === 'UL' || tag === 'OL') {
      return [...node.children].filter((el) => el.tagName === 'LI').map((li, i) => {
        const body = [...li.childNodes].filter((child) => !(child.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes(child.tagName))).map((child) => walk(child, depth + 1)).join('').trim();
        const nested = [...li.children].filter((el) => ['UL', 'OL'].includes(el.tagName)).map((el) => walk(el, depth + 1).trimEnd()).filter(Boolean).join('\n');
        return `${'  '.repeat(depth)}${tag === 'OL' ? `${i + 1}. ` : '• '}${body}${nested ? `\n${nested}` : ''}`;
      }).join('\n') + '\n';
    }
    if (tag === 'TD' || tag === 'TH') return [...node.childNodes].map((child) => walk(child, depth)).join('') + '\t';
    if (tag === 'TR') return [...node.children].map((child) => walk(child, depth)).join('').replace(/\t$/, '') + '\n';
    const content = [...node.childNodes].map((child) => walk(child, depth)).join('');
    return blocks.has(tag) ? `\n${content}\n` : content;
  };
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function restack() {
  const items = [...$('#toasts').children].reverse();
  items.forEach((t, i) => { t.style.setProperty('--i', Math.min(i, 3)); t.style.zIndex = String(100 - i); t.style.visibility = i > 3 ? 'hidden' : ''; });
}

export function toast(msg, { action, onAction, error = false, ms = 5000 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  const drop = () => { el.remove(); restack(); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action;
    b.onclick = async () => { drop(); try { await onAction?.(); } catch (e) { toast(e.message, { error: true }); } };
    el.append(b);
  }
  box.append(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  restack();
  setTimeout(drop, error ? Math.max(ms, 7000) : ms);
  return el;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

export const KIND_LABEL = { prompt: 'prompt', skill: 'skill', snippet: '片段', note: '笔记', resource: '推荐资源', unknown: '未分类' };

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let backdropBound = false;

export function openDialog({ title, body, foot = '', onMount, wide = false, cls = '', compact = false }) {
  const dlg = $('#dlg');
  dlg.className = 'dlg' + (cls ? ' ' + cls : '') + (compact ? ' compact' : '');
  dlg.style.width = wide ? 'min(960px, 96vw)' : compact ? 'min(340px, 92vw)' : '';
  const head = title ? `<div class="dlg-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-close aria-label="关闭">${icon('x')}</button></div>` : '';
  dlg.innerHTML = `${head}${cls === 'pal' ? body : `<div class="dlg-body">${body}</div>`}${foot ? `<div class="dlg-foot">${foot}</div>` : ''}`;
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  if (!backdropBound) {
    backdropBound = true;
    let downOnBackdrop = false;
    dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => { if (downOnBackdrop && e.target === dlg) dlg.close(); downOnBackdrop = false; });
  }
  if (!dlg.open) dlg.showModal();
  onMount?.(dlg);
  return dlg;
}
export const closeDialog = () => { const d = $('#dlg'); if (d.open) d.close(); };

export function confirmDialog(title, message, okText = '确认', danger = false) {
  return new Promise((resolve) => {
    const dlg = openDialog({
      title, body: `<p>${esc(message)}</p>`,
      foot: `<button class="btn" type="button" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" id="cfmOk">${esc(okText)}</button>`,
      onMount: (d) => { $('#cfmOk', d).onclick = () => { resolve(true); d.close(); }; },
    });
    dlg.addEventListener('close', () => resolve(false), { once: true });
  });
}
