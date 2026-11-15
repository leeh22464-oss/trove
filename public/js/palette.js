import { $, $$, esc, icon, get, openDialog, closeDialog, debounce, KIND_LABEL } from './lib.js';
import { state, emit } from './state.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const openItem = (id) => emit('open-item', id);

export function paletteKeyLabel() { return isMac ? '⌘ K' : 'Ctrl K'; }

function commands() {
  const dark = document.documentElement.classList.contains('wa-dark');
  return [
    { g: '前往', t: '收件箱', ic: 'inbox', run: () => emit('go', { type: 'inbox' }) },
    { g: '前往', t: '全部条目', ic: 'layers', run: () => emit('go', { type: 'all' }) },
    { g: '前往', t: '收藏', ic: 'star', run: () => emit('go', { type: 'favorite' }) },
    { g: '前往', t: '回收站', ic: 'trash-2', run: () => emit('go', { type: 'trash' }) },
    { g: '操作', t: '生成分类方案', ic: 'wand-sparkles', run: () => emit('go', { type: 'plan' }) },
    { g: '操作', t: '聚焦抓取栏', ic: 'clipboard', run: () => $('#capText').focus() },
    { g: '操作', t: '导入 / 导出', ic: 'download', run: () => emit('dialog', 'io') },
    { g: '操作', t: '设置', ic: 'settings', run: () => emit('dialog', 'settings') },
    { g: '操作', t: dark ? '切换到浅色' : '切换到深色', ic: dark ? 'sun' : 'moon', run: () => $('#btnTheme').click() },
    ...state.tags.map((tg) => ({ g: '标签', t: `#${tg.name}`, ic: 'hash', run: () => emit('go', { type: 'tag', name: tg.name }), k: tg.count })),
    ...state.collections.map((c) => ({ g: '集合', t: c.name, ic: 'folder', run: () => emit('go', { type: 'collection', id: c.id, name: c.name }), k: c.count })),
  ];
}

export function openPalette() {
  let results = [];
  let sel = 0;
  const dlg = openDialog({
    title: '', cls: 'pal',
    body: `<div class="pal-in">${icon('search')}<input id="palQ" type="text" role="combobox" aria-expanded="true" aria-controls="palList" placeholder="搜索条目，或输入命令、标签名" autocomplete="off" spellcheck="false"></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></div>`,
    onMount: (d) => {
      const q = $('#palQ', d), list = $('#palList', d);
      const paint = () => {
        if (!results.length) { list.innerHTML = '<div class="pal-empty">没有匹配项</div>'; return; }
        let last = '';
        list.innerHTML = results.map((r, i) => {
          const head = r.g !== last ? `<div class="pal-grp">${esc(r.g)}</div>` : '';
          last = r.g;
          return `${head}<button class="pal-item" type="button" role="option" id="po${i}" data-i="${i}" aria-selected="${i === sel}">${icon(r.ic)}<span class="grow">${esc(r.t)}</span>${r.sub ? `<span style="font-size:12px;opacity:.7">${esc(r.sub)}</span>` : ''}${r.k !== undefined ? `<kbd>${r.k}</kbd>` : ''}</button>`;
        }).join('');
        q.setAttribute('aria-activedescendant', `po${sel}`);
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      };
      const run = (r) => { closeDialog(); setTimeout(r.run, 60); };
      const search = async () => {
        const text = q.value.trim().toLowerCase();
        const cmds = commands().filter((c) => !text || c.t.toLowerCase().includes(text) || c.g.includes(text));
        let items = [];
        if (text) {
          try {
            const r = await get(`/api/items?limit=8&status=all&q=${encodeURIComponent(q.value.trim())}`);
            items = r.rows.map((it) => ({ g: '条目', t: it.title || '(未命名)', sub: KIND_LABEL[it.kind] || it.kind, ic: 'file-text', run: () => openItem(it.id) }));
          } catch { /* 搜索失败时仍显示命令 */ }
        }
        results = [...items, ...cmds].slice(0, 40);
        sel = 0; paint();
      };
      q.addEventListener('input', debounce(search, 120));
      q.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
        else if (e.key === 'Enter' && results[sel] && !e.isComposing) { e.preventDefault(); run(results[sel]); }
      });
      list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) run(results[Number(b.dataset.i)]); });
      list.addEventListener('pointermove', (e) => { const b = e.target.closest('[data-i]'); if (b && Number(b.dataset.i) !== sel) { sel = Number(b.dataset.i); $$('.pal-item', list).forEach((x, i) => x.setAttribute('aria-selected', i === sel)); } });
      search();
      q.focus();
    },
  });
  return dlg;
}
