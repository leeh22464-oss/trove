import { $, esc, icon, get, post, timeAgo, KIND_LABEL, debounce, toast, confirmDialog, openDialog, closeDialog } from './lib.js';
import { state, emit, buildQuery } from './state.js';

const FILTERS = [['', '全部'], ['prompt', 'prompt'], ['skill', 'skill'], ['snippet', '片段'], ['note', '笔记'], ['resource', '推荐资源'], ['unknown', '未分类']];
let loadSeq = 0;
let shownTotal = 0;
let firstPaint = true;

function placeSeg(animate = true) {
  const seg = $('#filters');
  const on = seg.querySelector('[aria-pressed="true"]');
  if (!on) return;
  seg.classList.toggle('no-anim', !animate);
  seg.style.setProperty('--seg-x', `${on.offsetLeft}px`);
  seg.style.setProperty('--seg-w', `${on.offsetWidth}px`);
  if (!animate) requestAnimationFrame(() => seg.classList.remove('no-anim'));
}

export function renderFilters(animate = true) {
  $('#filters').innerHTML = FILTERS.map(([k, l]) => `<button class="chip-btn" type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${l}</button>`).join('');
  placeSeg(animate);
}

function listUrl() {
  const v = state.view;
  const p = new URLSearchParams({ limit: '100' });
  let q = buildQuery();
  if (v.type === 'trash') p.set('status', 'trash');
  else if (v.type === 'inbox') q = `status:inbox ${q}`;
  else if (v.type === 'all' || v.type === 'tag' || v.type === 'favorite') p.set('status', 'all');
  if (v.type === 'favorite') q = `is:favorite ${q}`;
  return `/api/items?${p}&q=${encodeURIComponent(q.trim())}`;
}

function showSkeleton() {
  const ul = $('#cards');
  ul.hidden = false; $('#listEmpty').hidden = true;
  ul.innerHTML = Array.from({ length: 4 }, () => `<li class="skeleton" aria-hidden="true"><div class="sk" style="height:16px;width:62%"></div><div class="sk" style="height:12px;width:92%"></div><div class="sk" style="height:12px;width:48%"></div></li>`).join('');
}

export async function loadList({ keepSelection = true, skeleton = false } = {}) {
  const seq = ++loadSeq;
  const v = state.view;
  let rows, total;
  let skTimer;
  if (skeleton) skTimer = setTimeout(showSkeleton, 220); // 仅慢加载时显示，避免闪现
  try {
  if (v.type === 'collection') {
    const all = await get(`/api/collections/${v.id}/items`);
    const q = state.q.trim().toLowerCase();
    rows = all.filter((r) => (!state.kind || r.kind === state.kind) && (!q || `${r.title} ${r.content}`.toLowerCase().includes(q)) && r.status !== 'trash');
    total = rows.length;
  } else {
    ({ rows, total } = await get(listUrl()));
  }
  } finally { clearTimeout(skTimer); }
  if (seq !== loadSeq) return;
  // 差量比较：行数、id 顺序、标题、processing 没变化就不重渲，避免卡片闪烁
  const sameRows = state.rows.length === rows.length
    && state.rows.every((r, i) => {
      const n = rows[i];
      return n && r.id === n.id && r.title === n.title && r.processing === n.processing
        && r.updated_at === n.updated_at && r.favorite === n.favorite;
    });
  state.rows = rows; state.total = total;
  if (keepSelection && state.selectedId && !rows.some((r) => r.id === state.selectedId)) state.selectedId = null;
  if (!sameRows) renderList();
  emit('list-loaded');
}

const VIEW_TITLE = { inbox: '收件箱', all: '全部', favorite: '收藏', trash: '回收站' };
function metaName() {
  const v = state.view;
  return v.type === 'tag' ? `#${v.name}` : v.type === 'collection' ? v.name : VIEW_TITLE[v.type] || '';
}
const VIEW_HINT = { inbox: '待整理', all: '不含回收站', favorite: '星标', trash: '可恢复或清空' };

function countTo(el, to) {
  const from = shownTotal;
  shownTotal = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to; return; }
  const t0 = performance.now(), dur = 420;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1 && shownTotal === to) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderMeta() {
  const extra = state.q.trim() ? ` · 搜索「${esc(state.q.trim())}」` : '';
  const hint = VIEW_HINT[state.view.type] ? ` · ${VIEW_HINT[state.view.type]}` : '';
  const trashBtn = state.view.type === 'trash' && state.total > 0
    ? `<button class="linklike danger-link" type="button" id="btnEmptyTrash">清空回收站</button>` : '';
  $('#listMeta').innerHTML = `${esc(metaName())} · <span id="metaNum">${shownTotal}</span> 条${hint}${extra}${trashBtn}`;
  countTo($('#metaNum'), state.total);
}

function emptyHtml() {
  const v = state.view;
  if (state.q.trim() || state.kind) return `<h3>没有匹配的条目</h3><p>换个关键词，或清除筛选再试。</p><button class="btn" type="button" id="btnClear">清除搜索和筛选</button>`;
  if (v.type === 'trash') return `<h3>回收站是空的</h3><p>删除的条目会先放在这里。</p>`;
  if (v.type === 'favorite') return `<h3>还没有收藏</h3><p>在详情里点星标，常用的 prompt 会出现在这里。</p>`;
  if (v.type === 'inbox') return `<h3>收件箱是空的</h3><p>在下方粘贴文本、链接或截图，抓到的内容会先进入这里。</p><button class="btn primary" type="button" id="btnFocusCap">开始抓取</button>`;
  return `<h3>这里还没有内容</h3><p>在下方抓取栏粘贴文本、链接或截图开始收集。</p><button class="btn primary" type="button" id="btnFocusCap">开始抓取</button>`;
}

export function renderList() {
  renderMeta();
  const ul = $('#cards');
  ul.className = 'cards'; // 清除集合网格的 col-grid
  const empty = $('#listEmpty');
  // 集合视图：中栏顶部渲染文件夹横幅
  if (state.view.type === 'collection') {
    const c = state.collections.find(x => x.id === state.view.id) || { name: state.view.name };
    $('#listMeta').innerHTML = `<button class="collink" type="button" data-gocols>${icon('arrow-left', 'ico-sm')}集合</button>
      <span class="colhead"><span class="colhead-ic">${icon(colIcon(c.name))}</span><b>${esc(c.name)}</b><span class="colhead-n">${state.total} 条</span></span>`;
  }
  if (!state.rows.length) {
    ul.innerHTML = ''; ul.hidden = true;
    empty.hidden = false; empty.className = 'empty'; empty.innerHTML = emptyHtml();
    return;
  }
  empty.hidden = true; ul.hidden = false;
  ul.innerHTML = state.rows.map((r) => {
    const tags = (r.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t.name)}</span>`).join('');
    const body = r.summary || String(r.content || '').replace(/\s+/g, ' ').slice(0, 140);
    const busy = r.processing ? `<span class="busy"><span class="dot-live" aria-hidden="true"></span>处理中</span>` : '';
    const src = r.source_platform ? `<span>${esc(r.source_platform)}</span>` : '';
    const img = r.asset_count ? `<span>${icon('image', 'ico-sm')} ${r.asset_count}</span>` : '';
    const checked = state.sel.has(r.id);
    return `<li class="card${checked ? ' checked' : ''}" role="option" tabindex="-1" data-id="${r.id}" aria-selected="${r.id === state.selectedId}" aria-checked="${checked}">
      <span class="sel-box" role="checkbox" aria-checked="${checked}" aria-label="选中条目" data-sel="${r.id}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>
      ${r.favorite ? `<span class="fav" aria-label="已收藏">${icon('star', 'ico-sm')}</span>` : ''}
      <div class="t">${esc(r.title || '(未命名)')}</div>
      <div class="s">${esc(body)}</div>
      <div class="m"><span class="kind" data-k="${esc(r.kind)}">${esc(KIND_LABEL[r.kind] || r.kind)}</span>${tags}${src}${img}${busy}<span>${timeAgo(r.updated_at)}</span></div></li>`;
  }).join('');
  ul.setAttribute('role', 'listbox');
  renderBatchBar();
  firstPaint = false;
}

/* 集合总览：大屏文件夹卡片墙——白色磨砂卡 + 主题矢量图案（非 emoji） */

// 按集合名匹配主题图标（Lucide 名）与色调，统一中性绿/灰风格
const COL_THEMES = [
  [/写作|文案|润色|改写|文章|标题/i, 'pen-line'],
  [/编程|代码|开发|工具|技能|审查|git|调试|bug|api|sql/i, 'code-2'],
  [/绘画|设计|ui|视觉|美术|插画|海报/i, 'palette'],
  [/学习|成长|效率|笔记|教程|读书|知识/i, 'book-open'],
  [/产品|分析|数据|商业|需求|提问|方法|调研|报告/i, 'bar-chart-3'],
  [/翻译|语言|英语|中英|外语/i, 'languages'],
  [/视频|剪辑|音频|媒体|播客/i, 'clapperboard'],
  [/营销|推广|seo|运营|带货|广告/i, 'megaphone'],
  [/ai|prompt|提示|模型|llm|gpt|claude|skill|agent|mcp/i, 'sparkles'],
];
function colIcon(name) { const t = COL_THEMES.find(([re]) => re.test(name)); return t ? t[1] : 'folder'; }

export function renderCollectionsGrid() { /* 集合总览已改为悬浮面板 */ }

export function renderBatchBar() {
  let bar = $('#batchBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'batchBar';
    $('#list').appendChild(bar);
  }
  const n = state.sel.size;
  const trash = state.view.type === 'trash';
  bar.className = 'batch-bar' + (n ? ' on' : '');
  bar.innerHTML = n ? `<span class="b-n">${n} 项</span>
    ${trash
      ? `<button class="bb" type="button" data-act="restore" data-tip="恢复">${icon('undo-2')}</button><button class="bb danger" type="button" data-act="delete" data-tip="永久删除">${icon('trash-2')}</button>`
      : `<button class="bb" type="button" data-act="merge" data-tip="合并成一条">${icon('merge')}</button><button class="bb" type="button" data-act="tag" data-tip="加标签">${icon('hash')}</button><button class="bb" type="button" data-act="fav" data-tip="收藏">${icon('star')}</button><button class="bb" type="button" data-act="archive" data-tip="归档">${icon('archive')}</button><button class="bb danger" type="button" data-act="trash" data-tip="回收站">${icon('trash-2')}</button>`}
    <span class="b-div"></span><button class="bb ghost" type="button" data-act="clear" data-tip="取消">${icon('x')}</button>` : '';
}

function toggleSel(id, on) {
  on ? state.sel.add(id) : state.sel.delete(id);
  state.selectMode = state.sel.size > 0;
  const c = $('#cards').querySelector(`[data-id="${id}"]`);
  if (c) { c.classList.toggle('checked', on); c.setAttribute('aria-checked', on); c.querySelector('.sel-box')?.setAttribute('aria-checked', on); }
  renderBatchBar();
}

async function batch(action, payload = {}) {
  const ids = [...state.sel];
  if (!ids.length) return;
  try {
    const r = await post('/api/items/batch', { ids, action, ...payload });
    toast(`已处理 ${ids.length} 条`, { action: '撤销', onAction: async () => {
      const u = r.undo || [];
      for (const it of u) await post('/api/items/batch', { ids: [it.id], action: 'status', status: it.status });
      emit('refresh');
    }});
    state.sel.clear(); state.selectMode = false;
    renderBatchBar(); emit('refresh'); emit('deselect');
  } catch (e) { toast(e.message, { error: true }); }
}

export function markSelected() {
  $('#cards').querySelectorAll('.card').forEach((c) => {
    const on = Number(c.dataset.id) === state.selectedId;
    c.setAttribute('aria-selected', on);
    if (on) c.scrollIntoView({ block: 'nearest' });
  });
}

export function moveSelection(delta) {
  if (!state.rows.length) return;
  const i = state.rows.findIndex((r) => r.id === state.selectedId);
  const n = Math.min(state.rows.length - 1, Math.max(0, i < 0 ? (delta > 0 ? 0 : state.rows.length - 1) : i + delta));
  emit('select', state.rows[n].id);
}

export function initList() {
  const list = $('#list');
  const cards = $('#cards');
  const empty = $('#listEmpty');
  const area = document.createElement('div');
  area.className = 'scroll-area';
  cards.before(area);
  area.append(cards, empty);
  area.addEventListener('scroll', () => list.classList.toggle('scrolled', area.scrollTop > 2), { passive: true });

  renderFilters(false);
  addEventListener('resize', () => placeSeg(false));
  document.fonts?.ready.then(() => placeSeg(false));

  cards.addEventListener('click', (e) => {
    const selBox = e.target.closest('.sel-box');
    if (selBox) {
      const id = Number(selBox.dataset.sel);
      toggleSel(id, !state.sel.has(id));
      return;
    }
    const c = e.target.closest('.card');
    if (c) emit('select', Number(c.dataset.id));
  });
  cards.addEventListener('contextmenu', (e) => { // 右键切换批量模式
    const c = e.target.closest('.card');
    if (!c) return;
    e.preventDefault();
    toggleSel(Number(c.dataset.id), !state.sel.has(Number(c.dataset.id)));
  });
  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('[data-gocols]')) { emit('go', { type: 'collections' }); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (a === 'clear') { state.sel.clear(); state.selectMode = false; renderList(); renderBatchBar(); }
    else if (a === 'tag') {
      openDialog({ title: `给 ${state.sel.size} 条加标签`, compact: true,
        body: `<div class="field"><label for="btTag">标签名（可用 / 分层）</label><input id="btTag" type="text" placeholder="写作/润色"></div>`,
        foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="btOk">应用</button>`,
        onMount: (d) => { $('#btOk', d).onclick = () => { const t = $('#btTag', d).value.trim(); if (t) { closeDialog(); batch('tag', { tag: t }); } }; $('#btTag', d).focus(); } });
    } else if (a === 'fav') batch('favorite');
    else if (a === 'archive') batch('status', { status: 'archived' });
    else if (a === 'trash') batch('status', { status: 'trash' });
    else if (a === 'restore') batch('status', { status: 'inbox' });
    else if (a === 'merge') {
      const items = state.rows.filter(r => state.sel.has(r.id));
      if (items.length < 2) { toast('至少选择 2 条', { error: true }); return; }
      const mergedText = items.map((it, i) => `【${i + 1}｜${it.title || '未命名'}】\n${it.content || ''}`).join('\n\n');
      openDialog({
        title: `合并 ${items.length} 条`, wide: true,
        body: `<div class="clip-merge-list">${items.map((it, i) => `<div class="clip-merge-row"><span><strong>${esc(it.title || '(未命名)')}</strong><small>${esc(it.source_platform || it.source_url || '本地条目')}</small><span>${esc((it.summary || it.content || '').slice(0, 100))}${(it.summary || it.content || '').length > 100 ? '…' : ''}</span></span></div>`).join('')}</div><label class="clip-merge-label" for="mergePreview">合并正文（会重新清洗排版）</label><textarea id="mergePreview" class="clip-merge-text" spellcheck="false">${esc(mergedText)}</textarea><p class="hint" style="margin-top:8px;color:var(--c-text-3);font-size:12px">原条目会保留为已归档，合并条目详情里可查看每条来源和原文。</p>`,
        foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="mergeOk">合并并重新整理</button>`,
        onMount: (d) => {
          $('#mergeOk', d).onclick = async (e) => {
            e.currentTarget.disabled = true; e.currentTarget.textContent = '合并中…';
            const r = await post('/api/items/merge', { ids: [...state.sel], title: items[0].title ? `${items[0].title} 等 ${items.length} 条` : '', content: $('#mergePreview', d).value });
            if (r.error) { e.currentTarget.disabled = false; e.currentTarget.textContent = '合并并重新整理'; toast(r.error, { error: true }); return; }
            closeDialog();
            state.sel.clear(); state.selectMode = false; renderBatchBar();
            if (r.error) { toast(r.error, { error: true }); return; }
            toast('已合并，正在重新清洗');
            emit('refresh');
            emit('select', r.item.id);
          };
        },
      });
    }
    else if (a === 'delete') {
      confirmDialog('永久删除选中', `将永久删除 ${state.sel.size} 条，无法恢复。`, '永久删除', true).then((ok) => ok && batch('delete'));
    }
  });
  cards.addEventListener('pointermove', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', `${e.clientX - r.left}px`);
    c.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    state.kind = b.dataset.kind;
    $('#filters').querySelectorAll('.chip-btn').forEach((x) => x.setAttribute('aria-pressed', x === b));
    placeSeg(true);
    loadList();
  });
  $('#q').addEventListener('input', debounce((e) => { state.q = e.target.value; loadList(); }, 220));
  empty.addEventListener('click', (e) => {
    if (e.target.closest('#btnClear')) { state.q = ''; state.kind = ''; $('#q').value = ''; renderFilters(false); loadList(); }
    if (e.target.closest('#btnFocusCap')) $('#capText').focus();
  });
  $('#listMeta').addEventListener('click', async (e) => {
    if (!e.target.closest('#btnEmptyTrash')) return;
    if (!(await confirmDialog('清空回收站', `将永久删除 ${state.total} 条，无法恢复。`, '永久删除', true))) return;
    const r = await post('/api/trash/empty', { confirm: 'YES' });
    toast(`已永久删除 ${r.deleted} 条`);
    emit('refresh'); emit('deselect');
  });
}
