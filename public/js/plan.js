import { $, $$, esc, icon, get, post, patch, toast, confirmDialog } from './lib.js';
import { state, emit } from './state.js';

let plan = null;
let busy = false;

const host = () => {
  let el = $('#plan');
  if (!el) { el = document.createElement('section'); el.id = 'plan'; el.className = 'plan'; el.setAttribute('aria-label', '分类方案'); $('#app').append(el); }
  return el;
};

export function closePlan() { $('#plan')?.remove(); plan = null; }

export async function openPlan() {
  host().innerHTML = shell(`<div class="empty"><h3>正在读取…</h3></div>`, '');
  try {
    const rows = await get('/api/items?q=' + encodeURIComponent('status:inbox') + '&limit=1');
    renderStart(rows.total);
  } catch (e) { toast(e.message, { error: true }); }
}

function shell(body, foot) {
  return `<header class="plan-head">
    <button class="icon-btn only-narrow" type="button" id="plBack" aria-label="返回">${icon('arrow-left')}</button>
    <h1>分类方案</h1>${plan?.state === 'draft' ? `<button class="btn" type="button" id="plRegen">重新生成</button><button class="btn ghost" type="button" id="plDiscard">丢弃</button>` : ''}
    <button class="btn ghost" type="button" id="plClose">${icon('x')}关闭</button>
  </header>
  <div class="plan-body">${body}</div>${foot ? `<footer class="plan-foot">${foot}</footer>` : ''}`;
}

function renderStart(inboxTotal) {
  host().innerHTML = shell(`<div class="empty" style="margin-top:48px">
    <h3>让 AI 给收件箱出一份分类方案</h3>
    <p>生成时<strong>不会修改任何数据</strong>。你可以逐条改标签、改集合、排除不想动的条目，确认后一次应用，应用后还能整体撤销。</p>
    <p>当前收件箱有 <strong>${inboxTotal}</strong> 条，一次最多处理 50 条。${state.settings.llm_api_key_set === '1' ? '' : '<br>还没配置 LLM，将使用关键词启发式生成建议，质量一般，可在「设置」里填写。'}</p>
    <button class="btn primary big" type="button" id="plGen" ${inboxTotal ? '' : 'disabled'}>${icon('wand-sparkles')}生成方案</button></div>`, '');
  bindShell();
  $('#plGen').onclick = () => generate({ scope: 'inbox' });
}

async function generate(body) {
  if (busy) return;
  busy = true;
  host().innerHTML = shell(`<div class="empty" style="margin-top:48px"><h3>正在生成方案…</h3><p>每条约 1 到 3 秒，请稍候。</p></div>`, '');
  try { plan = await post('/api/classify/plans', body); renderPlan(); }
  catch (e) { toast(e.message, { error: true }); renderStart(0); }
  finally { busy = false; }
}

function stats() {
  const items = plan.plan.items.filter((i) => !i.exclude);
  const newTags = new Set(items.flatMap((i) => i.new_tags));
  const cols = new Set(items.map((i) => i.collection).filter(Boolean));
  const oldCols = new Set(state.collections.map((c) => c.name));
  return { n: items.length, newTags: newTags.size, newCols: [...cols].filter((c) => !oldCols.has(c)).length };
}

export function renderPlan() {
  const p = plan;
  if (p.state === 'applied') return renderApplied();
  const s = stats();
  const items = p.plan.items.map((it) => `<div class="plan-item${it.exclude ? ' off' : ''}" data-id="${it.item_id}">
    <div class="top"><input type="checkbox" ${it.exclude ? '' : 'checked'} data-inc="${it.item_id}" aria-label="包含：${esc(it.title)}">
      <span class="grow">${esc(it.title)}</span><span class="kind" data-k="${esc(it.kind)}">${esc(it.kind)}</span></div>
    ${it.error ? `<p class="status-line bad" style="margin-top:8px">${icon('triangle-alert', 'ico-sm')}生成失败：${esc(it.error)}</p>` : ''}
    <div class="plan-row"><span class="lbl">标签</span>
      ${it.add_tags.map((t) => `<span class="tag-chip">#${esc(t)}${it.new_tags.includes(t) ? '<span class="new-dot" title="新建标签"></span>' : ''}<button class="x" type="button" data-rm="${it.item_id}" data-t="${esc(t)}" aria-label="移除 ${esc(t)}">${icon('x', 'ico-sm')}</button></span>`).join('')}
      <input class="tag-add" data-add="${it.item_id}" placeholder="+ 标签" aria-label="给 ${esc(it.title)} 添加标签"></div>
    <div class="plan-row"><span class="lbl">集合</span>
      <input class="tag-add" style="width:180px;border-style:solid" list="colList" data-col="${it.item_id}" value="${esc(it.collection || '')}" placeholder="不归入集合" aria-label="集合"></div></div>`).join('');

  const merges = p.plan.merges.map((m, i) => `<div class="merge-row">${icon('merge')}<span class="grow">合并标签：<strong>#${esc(m.from)}</strong> 合并进 <strong>#${esc(m.to)}</strong></span><button class="btn sm" type="button" data-nomerge="${i}">忽略</button></div>`).join('');

  host().innerHTML = shell(`
    ${p.plan.truncated ? `<div class="merge-row" style="margin-bottom:12px">${icon('info')}<span class="grow">收件箱超过 50 条，本方案只含前 50 条，应用后再生成下一批。</span></div>` : ''}
    ${merges ? `<div style="margin-bottom:16px"><div class="sec-title" style="margin-top:0">合并建议</div>${merges}</div>` : ''}
    <datalist id="colList">${state.collections.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
    ${items || '<div class="empty"><h3>收件箱没有可分类的条目</h3></div>'}`,
    `<span class="grow">将处理 <strong>${s.n}</strong> 条，新建 <strong>${s.newTags}</strong> 个标签、<strong>${s.newCols}</strong> 个集合。<span style="color:var(--c-text-3)">带 <span class="new-dot"></span> 的是新标签。</span></span>
     <button class="btn primary big" type="button" id="plApply" ${s.n ? '' : 'disabled'}>确认并应用</button>`);
  bindShell();
  bindEdit();
}

function renderApplied() {
  const usedCols = [...new Set(plan.plan.items.filter((i) => !i.exclude && i.collection).map((i) => i.collection))];
  const colBtns = usedCols.map((c) => {
    const col = state.collections.find((x) => x.name === c);
    return `<button class="btn" type="button" data-col-view="${col ? col.id : ''}" data-col-name="${esc(c)}">${icon('folder')}查看集合「${esc(c)}」</button>`;
  }).join(' ');
  host().innerHTML = shell(`<div class="empty" style="margin-top:40px">
    <h3 style="color:var(--c-ok)">已应用</h3>
    <p style="max-width:520px;margin:0 auto">已写入标签${usedCols.length ? '，归入集合 ' + usedCols.map(c => `<strong>${esc(c)}</strong>`).join('、') : ''}。每条在应用前都存了版本，可整体撤销。</p>
    <div class="applied-next">${colBtns}<button class="btn ghost" type="button" id="plGoAll">${icon('layers')}查看全部条目</button><button class="btn" type="button" id="plUndo">${icon('undo-2')}撤销这次方案</button></div></div>`, '');
  bindShell();
  $('#plUndo').onclick = async () => {
    try {
      const r = await post(`/api/classify/plans/${plan.id}/undo`);
      plan = r;
      toast(r.merge_reverted ? '已撤销' : '已撤销标签和集合；被合并掉的标签不会恢复');
      emit('refresh'); closePlan(); emit('go', { type: 'inbox' });
    } catch (e) { toast(e.message, { error: true }); }
  };
  $('#plGoAll').onclick = () => emit('go', { type: 'all' });
  $$('[data-col-view]', host()).forEach((b) => { b.onclick = () => emit('go', { type: 'collection', id: Number(b.dataset.colView), name: b.dataset.colName }); });
}

function bindShell() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('#plClose', () => emit('go', { type: 'inbox' }));
  on('#plBack', () => emit('go', { type: 'inbox' }));
  on('#plRegen', async () => { if (await confirmDialog('重新生成', '当前的修改会丢失，重新向 AI 要一份方案。', '重新生成')) generate({ scope: 'inbox' }); });
  on('#plDiscard', async () => { await post(`/api/classify/plans/${plan.id}/discard`); toast('已丢弃方案'); emit('go', { type: 'inbox' }); });
}

// 局部修改后的重绘：保留滚动位置和焦点，避免整页弹回顶部
function rerender() {
  const body = host().querySelector('.plan-body');
  const st = body ? body.scrollTop : 0;
  const a = document.activeElement;
  const sel = a?.dataset?.add ? `[data-add="${a.dataset.add}"]`
    : a?.dataset?.col ? `[data-col="${a.dataset.col}"]`
    : a?.dataset?.inc ? `[data-inc="${a.dataset.inc}"]` : '';
  const caret = a?.selectionStart ?? null;
  renderPlan();
  const nb = host().querySelector('.plan-body');
  if (nb) nb.scrollTop = st;
  if (sel) {
    const el = host().querySelector(sel);
    if (el) { el.focus(); try { if (caret != null) el.setSelectionRange(caret, caret); } catch { } }
  }
}

async function save(items, merges) {
  try { plan = await patch(`/api/classify/plans/${plan.id}`, { items, merges }); rerender(); }
  catch (e) { toast(e.message, { error: true }); }
}

function bindEdit() {
  const root = host();
  const find = (id) => plan.plan.items.find((i) => i.item_id === Number(id));
  root.onchange = (e) => {
    const inc = e.target.closest('[data-inc]');
    if (inc) return save([{ item_id: Number(inc.dataset.inc), exclude: !inc.checked }]);
    const col = e.target.closest('[data-col]');
    if (col) save([{ item_id: Number(col.dataset.col), collection: col.value.trim() }]);
  };
  root.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { const it = find(rm.dataset.rm); return save([{ item_id: it.item_id, add_tags: it.add_tags.filter((t) => t !== rm.dataset.t) }]); }
    const nm = e.target.closest('[data-nomerge]');
    if (nm) return save([], plan.plan.merges.filter((_, i) => i !== Number(nm.dataset.nomerge)));
    if (e.target.closest('#plApply')) apply();
  };
  root.onkeydown = (e) => {
    const add = e.target.closest('[data-add]');
    if (!add || e.key !== 'Enter' || e.isComposing || !add.value.trim()) return;
    const it = find(add.dataset.add);
    save([{ item_id: it.item_id, add_tags: [...it.add_tags, add.value.trim()] }]);
  };
}

async function apply() {
  const s = stats();
  const btn = $('#plApply');
  btn.disabled = true; btn.textContent = '应用中…';
  try {
    plan = await post(`/api/classify/plans/${plan.id}/apply`);
    emit('refresh');
    toast(`已应用：处理 ${s.n} 条，新建 ${s.newTags} 个标签`, { action: '撤销', onAction: async () => {
      await post(`/api/classify/plans/${plan.id}/undo`); emit('refresh'); closePlan(); emit('go', { type: 'inbox' });
    }, ms: 10000 });
    renderApplied();
  } catch (e) { toast(e.message, { error: true }); btn.disabled = false; btn.textContent = '确认并应用'; }
}
