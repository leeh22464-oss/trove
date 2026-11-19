import { $, esc, icon, get } from './lib.js';
import { state, emit, saveExpanded, viewKey, buildTagTree } from './state.js';

const SYSTEM = [
  { type: 'inbox', label: '收件箱', icon: 'inbox', badge: true },
  { type: 'all', label: '全部', icon: 'layers' },
  { type: 'favorite', label: '收藏', icon: 'star' },
];

export async function refreshNav() {
  const [tags, cols, inbox, all, fav, trash] = await Promise.all([
    get('/api/tags'), get('/api/collections'),
    get('/api/items?q=' + encodeURIComponent('status:inbox') + '&limit=1'),
    get('/api/items?limit=1'),
    get('/api/items?q=' + encodeURIComponent('is:favorite') + '&limit=1'),
    get('/api/items?status=trash&limit=1'),
  ]);
  state.tags = tags.tags;
  state.pendingTags = tags.pending;
  state.collections = cols;
  state.counts = { inbox: inbox.total, all: all.total, favorite: fav.total, trash: trash.total };
  renderNav();
}

const cur = (v) => (viewKey(v) === viewKey() ? ' aria-current="true"' : '');

function tagNodes(node, depth) {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((n) => {
    const kids = n.children.size > 0;
    const open = state.expanded.has(n.full);
    const v = { type: 'tag', name: n.full };
    const shown = n.tag ? n.own : n.count;
    return `<button class="nav-item sub" type="button" data-nav="tag" data-name="${esc(n.full)}"${cur(v)} aria-expanded="${open}" style="padding-left:${28 + depth * 16}px">
      <span class="twirl${kids ? '' : ' leaf'}"${kids ? ` data-twirl="${esc(n.full)}"` : ' data-leaf-twirl'}>${icon('chevron-right')}</span>
      <span><span class="tag-hash">#</span> ${esc(n.name)}</span><span class="count">${shown}</span></button>${kids && open ? tagNodes(n, depth + 1).join('') : ''}`;
  });
}

export function renderNav() {
  const sys = SYSTEM.map((s) => {
    const c = state.counts[s.type];
    const badge = s.badge && c > 0 ? `<span class="nav-badge">${c}</span>` : `<span class="count">${c}</span>`;
    return `<button class="nav-item" type="button" data-nav="${s.type}"${cur(s)}>${icon(s.icon)}<span>${s.label}</span>${badge}</button>`;
  }).join('');

  const tree = buildTagTree(state.tags);
  const tagsHtml = tree.children.size
    ? tagNodes(tree, 0).join('')
    : '<div class="nav-group plain">还没有标签。用「分类方案」让 AI 给出建议。</div>';

  // 集合按 parent_id 组树：父级可展开分组，子集合缩进
  const colItem = (c, depth) => `<button class="nav-item sub col-item${depth ? ' col-sub' : ''}" type="button" data-nav="collection" data-id="${c.id}" data-name="${esc(c.name)}"${cur({ type: 'collection', id: c.id })} style="padding-left:${28 + depth * 16}px"><span class="twirl leaf" data-leaf-twirl>${icon('chevron-right')}</span><span>${esc(c.name)}</span><span class="count">${c.count}</span></button>`;
  const kids = (pid) => state.collections.filter((c) => (c.parent_id || null) === pid)
    .sort((a, b) => { const ka = kids(a.id).length, kb = kids(b.id).length; return ka - kb || a.name.localeCompare(b.name, 'zh'); });
  const colNodes = (pid, depth) => kids(pid).map((c) => {
    const sub = kids(c.id);
    if (!sub.length) return colItem(c, depth);
    // 父级默认收起，用户展开才记 __col_X
    const open = state.expanded.has('__col_' + c.id);
    return `<button class="nav-item sub col-parent" type="button" data-col-toggle="${c.id}" aria-expanded="${open}" data-nav="collection" data-id="${c.id}" data-name="${esc(c.name)}"${cur({ type: 'collection', id: c.id })} style="padding-left:${28 + depth * 16}px"><span class="twirl${open ? ' open' : ''}">${icon('chevron-right')}</span><span>${esc(c.name)}</span><span class="count">${c.count}</span></button>${open ? colNodes(c.id, depth + 1) : ''}`;
  }).join('');
  const cols = colNodes(null, 0);

  const pending = state.pendingTags.length;
  const tagsOpen = state.expanded.has('__tags__');
  // 集合默认收起，用户展开才记 __cols__
  const colsOpen = state.expanded.has('__cols__');
  $('#navTree').innerHTML = `
    ${sys}
    <div class="nav-group nav-toggle" data-toggle="cols" aria-expanded="${colsOpen}"><span class="twirl${colsOpen ? ' open' : ''}">${icon('chevron-right')}</span><span class="nav-group-link" data-nav-all="collections">集合</span><button class="nav-add" type="button" data-act="new-col" aria-label="新建集合">${icon('plus')}</button></div>
    ${colsOpen ? (cols || '<div class="nav-group plain">暂无集合</div>') : ''}
    <div class="nav-group nav-toggle" data-toggle="tags" aria-expanded="${tagsOpen}"><span class="twirl${tagsOpen ? ' open' : ''}">${icon('chevron-right')}</span>标签</div>
    ${tagsOpen ? tagsHtml : ''}
    <div class="nav-group">整理</div>
    <button class="nav-item no-ico" type="button" data-nav="plan"${cur({ type: 'plan' })}><span>分类方案</span></button>
    ${pending ? `<button class="nav-item no-ico" type="button" data-nav="pending"><span>待审标签</span><span class="nav-badge">${pending}</span></button>` : ''}
    <button class="nav-item no-ico" type="button" data-nav="trash"${cur({ type: 'trash' })}><span>回收站</span><span class="count">${state.counts.trash}</span></button>
    <button class="nav-item no-ico" type="button" data-nav="io"><span>导入 / 导出</span></button>
    <button class="nav-item no-ico" type="button" data-nav="settings"><span>设置</span></button>`;
}

export function initNav() {
  $('#navTree').addEventListener('click', async (e) => {
    // 集合标题文字 → 集合总览；箭头 → 折叠
    if (e.target.closest('[data-nav-all="collections"]')) { emit('go', { type: 'collections' }); return; }
    const ct = e.target.closest('[data-col-toggle]');
    if (ct) {
      const cid = Number(ct.dataset.colToggle);
      if (e.target.closest('.twirl')) {
        const k = '__col_' + cid;
        state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
        saveExpanded(); renderNav();
      } else emit('go', { type: 'collection', id: cid, name: ct.dataset.name });
      return;
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog && !e.target.closest('[data-act="new-col"]') && !e.target.closest('[data-nav-all]')) {
      const t = tog.dataset.toggle;
      if (t === 'tags') { state.expanded.has('__tags__') ? state.expanded.delete('__tags__') : state.expanded.add('__tags__'); }
      else if (t === 'cols') { state.expanded.has('__cols__') ? state.expanded.delete('__cols__') : state.expanded.add('__cols__'); }
      saveExpanded(); renderNav();
      return;
    }
    if (e.target.closest('[data-act="new-col"]')) {
      emit('dialog', 'new-collection');
      return;
    }
    const tw = e.target.closest('[data-twirl]');
    if (tw && !tw.classList.contains('none')) {
      const k = tw.dataset.twirl;
      state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
      saveExpanded(); renderNav();
      return;
    }
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    const t = b.dataset.nav;
    if (t === 'tag') emit('go', { type: 'tag', name: b.dataset.name });
    else if (t === 'collection') emit('go', { type: 'collection', id: Number(b.dataset.id), name: b.dataset.name });
    else if (['settings', 'io', 'pending'].includes(t)) emit('dialog', t);
    else emit('go', { type: t });
  });
}
