import { $, $$, esc, icon, get, post, api, toast, confirmDialog, openDialog, closeDialog } from './lib.js';
import { state, on, emit, viewKey } from './state.js';
import { initNav, refreshNav, renderNav } from './nav.js';
import { initList, loadList, markSelected, moveSelection } from './list.js';
import { showItem, renderEmpty, refreshCurrent, copyItem, toggleFavorite, current } from './detail.js';
import { openPlan, closePlan } from './plan.js';
import { openSettings, openIo, openPending, openKind, openCollection, openNewCollection } from './dialogs.js';
import { openPalette, paletteKeyLabel } from './palette.js';
import { initLiquidChrome } from './liquidChrome.js';

const app = $('#app');
const narrow = () => matchMedia('(max-width: 880px)').matches;

function setView(v) { app.dataset.view = v; }

function openSelectionClips(clips) {
  const list = clips.filter(c => c?.text?.trim());
  if (!list.length) { toast('没有可合并的暂存文字', { error: true }); return; }
  const checked = new Set(list.map((_, i) => i));
  const renderRows = () => list.map((c, i) => `<label class="clip-merge-row"><input type="checkbox" data-clip="${i}" checked><span><strong>片段 ${i + 1}</strong><small>${esc(c.title || c.url || '')}</small><span>${esc(c.text.slice(0, 120))}${c.text.length > 120 ? '…' : ''}</span></span></label>`).join('');
  const merged = () => list.filter((_, i) => checked.has(i)).map(c => c.text.trim()).join('\n\n');
  openDialog({
    title: `合并选区 · ${list.length} 段`,
    body: `<div class="clip-merge-list">${renderRows()}</div><label class="clip-merge-label" for="clipMergeText">清洗前内容（可编辑）</label><textarea id="clipMergeText" class="clip-merge-text" spellcheck="false"></textarea>`,
    foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="clipMergeSave">合并并清洗保存</button>',
    onMount: (d) => {
      const textarea = $('#clipMergeText', d);
      textarea.value = merged();
      d.querySelectorAll('[data-clip]').forEach(box => box.addEventListener('change', () => {
        const i = Number(box.dataset.clip);
        box.checked ? checked.add(i) : checked.delete(i);
        textarea.value = merged();
      }));
      $('#clipMergeSave', d).onclick = async (e) => {
        const text = textarea.value.trim();
        if (!text) { toast('合并内容不能为空', { error: true }); return; }
        e.currentTarget.disabled = true; e.currentTarget.textContent = '保存中…';
        try {
          const source = list.find((_, i) => checked.has(i)) || list[0];
          const r = await post('/api/capture', { text, url: source.url || '', title: source.title || '', source: 'extension-selection-batch' });
          closeDialog();
          if (r.count) {
            toast('已合并保存，正在清洗');
            if (state.view.type !== 'inbox') await go({ type: 'inbox' }); else await refresh();
            if (r.items?.[0]) await select(r.items[0].id);
          } else toast(`已有相同内容：${r.duplicate?.exact?.[0]?.title || ''}`);
        } catch (err) { toast(err.message, { error: true }); e.currentTarget.disabled = false; e.currentTarget.textContent = '合并并清洗保存'; }
      };
    },
  });
}

let catchAppStarted = false;
window.__catchClipsReady = () => catchAppStarted;
const pendingSelectionClips = [];
window.addEventListener('catch-selection-clips', e => {
  const clips = Array.isArray(e.detail) ? e.detail : [];
  if (!clips.length) return;
  if (catchAppStarted) openSelectionClips(clips);
  else pendingSelectionClips.push(...clips);
});

// 液态金属背景单例：总览/下钻/条目浮层共用一份，引用计数管理生命周期
const chromeBg = { host: null, stop: null, refs: 0 };
function chromeBgAcquire() {
  if (!chromeBg.host) {
    chromeBg.host = document.createElement('div');
    chromeBg.host.className = 'ft-host'; chromeBg.host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(chromeBg.host);
    chromeBg.stop = initLiquidChrome(chromeBg.host, { color: '#9ecb6a', speed: 0.25, amplitude: 0.4, detail: 5, thickness: 1.1, depth: 1, roughness: 0.35, exposure: 1.1, interactive: true, rippleStrength: 1, tilt: 1 });
  }
  let released = false;
  return () => { if (released) return; released = true; chromeBg.stop?.(); chromeBg.stop = null; chromeBg.host?.remove(); chromeBg.host = null; };
}

// 集合条目浮层：悬浮展示该集合条目，液态金属背景，不切主视图
async function openCollectionView(col, back) {
  const items = await get(`/api/collections/${col.id}/items`);
  openDialog({
    title: col.name, wide: true, cls: 'colsheet',
    body: `<div class="colv-content items-view">${items.length
      ? `<ul class="colitems">${items.map((it) => `<li><div class="colit" role="button" tabindex="0" data-open="${it.id}"><div class="ci-row"><div class="ci-title">${esc(it.title || '(未命名)')}</div><div class="ci-kind" data-k="${esc(it.kind)}">${esc({ prompt: 'prompt', skill: 'skill', snippet: '片段', note: '笔记', resource: '推荐资源', unknown: '未分类' }[it.kind] || it.kind)}</div></div><div class="ci-sum">${esc((it.summary || '').slice(0, 60))}</div></div></li>`).join('')}</ul>`
      : '<p class="empty-hint">这个集合还没有条目。把条目加进来后在这里快速浏览。</p>'}</div>`,
    onMount: (d) => {
      d._ft = chromeBgAcquire();
      const head = d.querySelector('.dlg-head');
      if (head && back) {
        const backBtn = document.createElement('button');
        backBtn.className = 'btn sm ghost'; backBtn.type = 'button'; backBtn.innerHTML = `${icon('arrow-left', 'ico-sm')}`;
        backBtn.onclick = back;
        head.insertBefore(backBtn, head.firstChild);
      }
      d.onclick = async (e) => {
        const b = e.target.closest('[data-open]');
        if (b) { closeDialog(); await go({ type: 'all' }); await select(Number(b.dataset.open)); }
      };
      d.onkeydown = async (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const b = e.target.closest('[data-open]');
        if (b) { e.preventDefault(); closeDialog(); await go({ type: 'all' }); await select(Number(b.dataset.open)); }
      };
    },
  });
}

// 集合总览浮层：悬浮显示集合卡片，两级嵌套导航，不切主视图
async function openCollectionsSheet() {
  await refreshNav();
  const kids = (pid) => state.collections.filter((c) => (c.parent_id || null) === pid);
  const nameOf = (id) => state.collections.find((x) => x.id === id)?.name;

  // 精致拟物文件夹 SVG：背部板+前盖+纸张+主题图标，渐变高光质感

  const path = []; // 层级栈：[{id, name}, ...]
  const show = (pid, parentName) => {
    const cols = kids(pid);
    const grid = `<div class="colv-grid" role="list">${cols.map((c) => `
      <button class="colcard" type="button" role="listitem" data-col="${c.id}" data-name="${esc(c.name)}" style="--cf-col:#a8d94a">
        <span class="cover" aria-hidden="true" ${localStorage.getItem(`col-bg-${c.id}`) ? `style="background-image:url(${localStorage.getItem(`col-bg-${c.id}`)})"` : ''}></span>
        <span class="content">
          <span class="title">${esc(c.name)}</span>
          <span class="stats"><span class="count"><strong class="number">${c.count || 0}</strong><span class="unit">条</span></span></span>
        </span>
      </button>`).join('')}</div>`;
    openDialog({
      title: pid ? parentName : '', wide: true, cls: 'colsheet',
      body: `<div class="colv-content">${cols.length ? grid : '<p class="empty-hint">这一层还没有集合。</p>'}</div>`,
      onMount: (d) => {
        d._ft = chromeBgAcquire();
        const head = d.querySelector('.dlg-head');
        if (head) {
          if (pid) {
            const back = document.createElement('button');
            back.className = 'btn sm ghost'; back.type = 'button'; back.innerHTML = `${icon('arrow-left', 'ico-sm')}`;
            back.onclick = () => {
              path.pop(); // 弹出当前层
              const prev = path[path.length - 1];
              show(prev ? prev.id : null, prev ? prev.name : null);
            };
            head.insertBefore(back, head.firstChild);
          }
          const newBtn = document.createElement('button');
          newBtn.className = 'btn sm'; newBtn.type = 'button'; newBtn.innerHTML = `${icon('plus', 'ico-sm')}新建集合`;
          newBtn.onclick = () => { closeDialog(); emit('dialog', 'new-collection'); };
          if (pid) head.insertBefore(newBtn, head.querySelector('.icon-btn')); else head.insertBefore(newBtn, head.firstChild);
        }
        d.onclick = (e) => {
          const card = e.target.closest('.colcard');
          if (!card) return;
          const id = Number(card.dataset.col), name = card.dataset.name;
          if (kids(id).length) { path.push({ id, name }); show(id, name); }
          else {
            path.push({ id, name });
            openCollectionView({ id, name }, () => {
              path.pop();
              const prev = path[path.length - 1];
              show(prev ? prev.id : null, prev ? prev.name : null);
            });
          }
        };
        // 右键卡片：更换/清除封面背景图
        d.oncontextmenu = (e) => {
          const card = e.target.closest('.colcard');
          if (!card) return;
          const cover = card.querySelector('.cover');
          if (!cover) return;
          e.preventDefault();
          const id = Number(card.dataset.col);
          const key = `col-bg-${id}`;
          const menu = document.createElement('div');
          menu.className = 'ctx-menu';
          menu.innerHTML = `<button type="button" data-a="set">更换封面图</button>${localStorage.getItem(key) ? '<button type="button" data-a="clear">恢复默认</button>' : ''}`;
          const cr = card.getBoundingClientRect();
          menu.style.cssText = `position:fixed;left:${cr.left + cr.width / 2}px;top:${cr.bottom + 8}px;transform:translateX(-50%);z-index:2147483647;`;
          (d || document.body).appendChild(menu);
          // 防止菜单跑出屏幕边缘
          requestAnimationFrame(() => {
            const r = menu.getBoundingClientRect();
            if (r.left < 8) menu.style.left = `${8 + r.width / 2}px`;
            if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - 8 - r.width / 2}px`;
            if (r.bottom > innerHeight - 8) { menu.style.top = `${cr.top - 8 - r.height}px`; }
          });
          const cleanup = () => { menu.remove(); document.removeEventListener('pointerdown', off, true); };
          const off = (ev) => { if (!menu.contains(ev.target)) cleanup(); };
          document.addEventListener('pointerdown', off, true);
          menu.onclick = (ev) => {
            const act = ev.target.dataset.a;
            cleanup();
            if (act === 'clear') { localStorage.removeItem(key); cover.style.backgroundImage = ''; }
            if (act !== 'set') return;
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.onchange = () => {
              const f = inp.files[0];
              if (!f) return;
              const img = new Image();
              img.onload = () => {
                const MAX = 720;
                const sc = Math.min(1, MAX / Math.max(img.width, img.height));
                const cv = document.createElement('canvas');
                cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                const url = cv.toDataURL('image/jpeg', .82);
                try { localStorage.setItem(key, url); } catch (_) {}
                cover.style.backgroundImage = `url(${url})`;
              };
              img.src = URL.createObjectURL(f);
            };
            inp.click();
          };
        };
      },
    });
  };
  show(null);
}

async function go(view) {
  // collection / collections 弹浮层，不改变主视图
  if (view.type === 'collection') { await openCollectionView(view, () => openCollectionsSheet()); renderNav(); return; }
  if (view.type === 'collections') { await openCollectionsSheet(); renderNav(); return; }
  state.view = view;
  state.selectedId = null;
  state.sel.clear(); state.selectMode = false;
  app.dataset.nav = '';
  $('#scrim').hidden = true;
  closePlan();
  if (view.type === 'plan') { setView('plan'); renderNav(); openPlan(); return; }
  setView('list');
  renderEmpty();
  renderNav();
  await loadList({ keepSelection: false, skeleton: true });
}

async function select(id) {
  state.selectedId = id;
  markSelected();
  if (narrow()) setView('detail');
  await showItem(id);
}

async function refresh() {
  await Promise.all([refreshNav(), state.view.type === 'plan' ? null : loadList()]);
  markSelected();
}

on('go', go);
on('select', select);
on('open-item', async (id) => { await go({ type: 'all' }); await select(id); });
on('refresh', refresh);
on('back', () => { setView('list'); });
on('deselect', () => { state.selectedId = null; renderEmpty(); markSelected(); if (narrow()) setView('list'); });
on('dialog', (name) => ({ settings: openSettings, io: openIo, pending: openPending, kind: openKind, collection: openCollection, 'new-collection': openNewCollection }[name]?.()));

/* ---------- 抓取 ---------- */
const pics = [];
const capText = $('#capText');

let imgMode = 'merge'; // merge=合并为一条 / split=每张分开
function renderThumbs() {
  const box = $('#capThumbs');
  const mode = $('#capImgsMode');
  box.innerHTML = pics.map((p, i) => `<div class="cap-thumb"><img src="${p.url}" alt="待上传图片 ${i + 1}"><button type="button" data-rm="${i}" aria-label="移除图片 ${i + 1}">${icon('x', 'ico-sm')}</button></div>`).join('');
  if (mode) { box.appendChild(mode); mode.hidden = pics.length < 2; }
  box.classList.toggle('has-pics', pics.length > 0);
}
$('#capImgsMode').onclick = (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  imgMode = b.dataset.mode;
  $$('#capImgsMode [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
};
function addPics(files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { toast(`不支持的图片类型：${f.type || f.name}`, { error: true }); continue; }
    if (f.size > 12 * 1024 * 1024) { toast(`${f.name || '图片'} 超过 12MB`, { error: true }); continue; }
    pics.push({ file: f, url: URL.createObjectURL(f) });
  }
  renderThumbs();
}
function growText() { capText.style.height = 'auto'; capText.style.height = Math.min(capText.scrollHeight, 160) + 'px'; }

async function save() {
  const text = capText.value.trim();
  if (!text && !pics.length) { toast('先粘贴文本、链接或图片', { error: true }); capText.focus(); return; }
  const btn = $('#capSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    let r;
    const split = /^={5,}\s*$/m.test(text);
    // 只有明确用 ===== 分隔才弹拆分预览（粘贴多段用空行拼成一条，不拆）
    if (!pics.length && split) {
      const pv = await post('/api/capture/preview', { text });
      if (pv.segments?.length > 1) {
        btn.disabled = false; btn.textContent = '保存';
        openSplitPreview(pv.segments);
        return;
      }
    }
    if (pics.length) {
      const fd = new FormData();
      fd.append('payload', JSON.stringify({ text, split, split_images: imgMode === 'split' }));
      pics.forEach((p) => fd.append('images', p.file, p.file.name || 'image.png'));
      r = await api('POST', '/api/capture', fd);
    } else r = await post('/api/capture', { text, split });
    if (!r.count && r.duplicate?.exact?.length) {
      const d = r.duplicate.exact[0];
      toast(`已存在相同内容：${d.title}`, { action: '查看', onAction: () => go({ type: 'all' }).then(() => select(d.id)) });
    } else {
      const near = r.duplicate?.near?.[0];
      toast(r.count > 1 ? `已保存 ${r.count} 条到收件箱` : '已保存到收件箱', near ? { action: `疑似重复：${near.title.slice(0, 12)}`, onAction: () => select(near.id), ms: 8000 } : {});
      capText.value = ''; pics.splice(0).forEach((p) => URL.revokeObjectURL(p.url)); renderThumbs(); growText();
      if (state.view.type !== 'inbox') await go({ type: 'inbox' }); else await refresh();
      if (r.items?.[0]) select(r.items[0].id);
    }
  } catch (e) { toast(e.message, { error: true }); }
  finally { btn.disabled = false; btn.textContent = '保存'; }
}

/* 拆分预览：列出拆出的多条，可勾选/删除，确认后批量入库 */
function openSplitPreview(segments) {
  const list = segments.map((s, i) => s);
  const render = () => {
    $('#spList').innerHTML = list.map((s, i) => `<label class="sp-row">
      <input type="checkbox" data-i="${i}" checked>
      <span class="sp-text">${esc(s.preview || s.text.slice(0, 60))}</span>
      <span class="sp-len">${s.text.length}</span>
      <button type="button" class="sp-del" data-del="${i}" aria-label="删除此条">${icon('x', 'ico-sm')}</button>
    </label>`).join('') || '<div class="empty" style="margin:20px">已无可入库条目</div>';
    $('#spOk').textContent = `保存 ${list.filter((_, i) => $(`#spList [data-i="${i}"]`)?.checked !== false).length} 条`;
    $$('#spList [data-i]').forEach((c) => c.onchange = () => {
      const n = $$('#spList [data-i]').filter((x) => x.checked).length;
      $('#spOk').textContent = `保存 ${n} 条`;
    });
    $$('#spList [data-del]').forEach((b) => b.onclick = () => { list.splice(Number(b.dataset.del), 1); render(); });
  };
  openDialog({
    title: `拆分为 ${segments.length} 条`, wide: false,
    body: `<div class="sp-tip">已按空行/===== 拆出下列条目，勾选要入库的：</div><div class="sp-list" id="spList"></div>`,
    foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="spOk">保存</button>`,
    onMount: (d) => {
      render();
      $('#spOk', d).onclick = async () => {
        const keep = list.filter((_, i) => $(`#spList [data-i="${i}"]`)?.checked);
        if (!keep.length) { closeDialog(); return; }
        $('#spOk').disabled = true; $('#spOk').textContent = '保存中…';
        let ok = 0, dup = 0;
        for (const s of keep) {
          try {
            const r = await post('/api/capture', { text: s.text });
            (r.count || r.items?.length) ? ok++ : dup++;
          } catch { }
        }
        closeDialog();
        capText.value = ''; growText();
        toast(dup ? `已保存 ${ok} 条，跳过 ${dup} 条重复` : `已保存 ${ok} 条到收件箱`);
        if (state.view.type !== 'inbox') await go({ type: 'inbox' }); else await refresh();
      };
    },
  });
}

$('#capSave').onclick = save;
$('#capFile').onclick = () => $('#capFileInput').click();
$('#capFileInput').onchange = (e) => { addPics(e.target.files); e.target.value = ''; };
$('#capThumbs').onclick = (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) { URL.revokeObjectURL(pics[b.dataset.rm].url); pics.splice(b.dataset.rm, 1); renderThumbs(); }
};
capText.addEventListener('input', growText);
capText.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });

const bar = $('#captureBar');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); bar.classList.add('dragover'); } }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { if (ev === 'dragleave' && e.relatedTarget) return; bar.classList.remove('dragover'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addPics(e.dataTransfer.files); } });

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  const inField = e.target.closest?.('input, textarea');
  if (files.length) { e.preventDefault(); addPics(files); if (!inField) capText.focus(); return; }
  if (!inField) {
    const t = e.clipboardData?.getData('text');
    if (t) {
      e.preventDefault();
      // 已有内容 → 空行分隔追加，多段累加成一条
      const had = !!capText.value.trim();
      capText.value = (had ? capText.value.replace(/\s+$/, '') + '\n\n' : '') + t;
      growText(); capText.focus();
      if (had) toast('已追加到抓取栏，多段会合成一条', { ms: 2200 });
      else toast('已放进抓取栏，确认后点保存（Ctrl+Enter）');
    }
  }
});

/* ---------- 快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t.closest?.('input, textarea, select, [contenteditable]');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!$('#dlg').open) openPalette(); return; }
  if (e.key === 'Escape' && typing && t.id === 'q') { t.blur(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#dlg').open) return;
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'j') moveSelection(1);
  else if (e.key === 'k') moveSelection(-1);
  else if (e.key === 'c') copyItem();
  else if (e.key === 's') toggleFavorite();
  else if (e.key === 'Escape' && narrow() && app.dataset.view === 'detail') setView('list');
});

/* ---------- 主题与窄屏导航 ---------- */
function setTheme(dark) {
  document.documentElement.className = dark ? 'wa-dark' : 'wa-light';
  localStorage.setItem('catch.theme', dark ? 'dark' : 'light');
  $('#btnTheme').innerHTML = `${icon(dark ? 'sun' : 'moon')}<span>${dark ? '切换到浅色' : '切换到深色'}</span>`;
}
$('#btnTheme').onclick = () => setTheme(!document.documentElement.classList.contains('wa-dark'));
setTheme(document.documentElement.classList.contains('wa-dark'));

$('#palKey').textContent = paletteKeyLabel();
$('#btnPalette').onclick = () => openPalette();

/* ---------- 可调整面板：拖动列表栏右边缘，双击还原 ---------- */
(() => {
  const rz = $('#resizer');
  const MIN = 280, MAX = 560, DEF = 380;
  const set = (w) => { w = Math.max(MIN, Math.min(MAX, Math.round(w))); document.documentElement.style.setProperty('--list-w', w + 'px'); return w; };
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('drag'); document.body.classList.add('resizing');
    const left = $('#list').getBoundingClientRect().left;
    const move = (ev) => set(ev.clientX - left);
    const up = (ev) => {
      rz.releasePointerCapture(ev.pointerId); rz.classList.remove('drag'); document.body.classList.remove('resizing');
      localStorage.setItem('catch.listW', String(set(ev.clientX - left)));
      rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up);
    };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  });
  rz.addEventListener('dblclick', () => { set(DEF); localStorage.removeItem('catch.listW'); });
  rz.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = $('#list').getBoundingClientRect().width;
    localStorage.setItem('catch.listW', String(set(cur + (e.key === 'ArrowRight' ? 16 : -16))));
  });
})();

$('#btnMenu').onclick = () => { app.dataset.nav = 'open'; $('#scrim').hidden = false; };
$('#scrim').onclick = () => { app.dataset.nav = ''; $('#scrim').hidden = true; };

/* ---------- 实时刷新：SSE + 兜底轮询 ---------- */
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => { await refresh(); await refreshCurrent(); }, 400); };
try {
  const es = new EventSource('/api/events');
  es.addEventListener('item', scheduleRefresh);
  es.addEventListener('items', scheduleRefresh);
} catch { /* 无 SSE 时靠轮询 */ }
setInterval(() => { if (state.rows.some((r) => r.processing) || current()?.processing) scheduleRefresh(); }, 4000);

/* ---------- 启动 ---------- */
initNav();
initList();
renderEmpty();
(async () => {
  try {
    state.settings = await get('/api/settings');
    await refreshNav();
    await go({ type: state.counts.inbox ? 'inbox' : 'all' });
  } catch (e) { toast(e.message, { error: true }); }
  catchAppStarted = true;
  const pending = [...(window.__catchSelectionClips || []), ...pendingSelectionClips];
  window.__catchSelectionClips = [];
  pendingSelectionClips.length = 0;
  if (new URLSearchParams(location.search).has('captureClips') && pending.length) openSelectionClips(pending);
})();
