import { $, $$, esc, icon, get, post, api, toast, confirmDialog, openDialog, closeDialog } from './lib.js';
import { state, on, emit, viewKey } from './state.js';
import { initNav, refreshNav, renderNav } from './nav.js';
import { initList, loadList, markSelected, moveSelection } from './list.js';
import { showItem, renderEmpty, refreshCurrent, copyItem, toggleFavorite, current } from './detail.js';
import { openPlan, closePlan } from './plan.js';
import { openSettings, openIo, openPending, openKind, openCollection, openNewCollection } from './dialogs.js';
import { openPalette, paletteKeyLabel } from './palette.js';

const app = $('#app');
const narrow = () => matchMedia('(max-width: 880px)').matches;

function setView(v) { app.dataset.view = v; }

async function go(view) {
  state.view = view;
  state.selectedId = null;
  state.sel.clear(); state.selectMode = false;
  app.dataset.nav = '';
  $('#scrim').hidden = true;
  closePlan();
  if (view.type === 'plan') { setView('plan'); renderNav(); openPlan(); return; }
  if (view.type === 'collections') { setView('collections'); renderNav(); await loadList({ keepSelection: false, skeleton: true }); return; }
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
  $('#capThumbs').innerHTML = pics.map((p, i) => `<div class="cap-thumb"><img src="${p.url}" alt="待上传图片 ${i + 1}"><button type="button" data-rm="${i}" aria-label="移除图片 ${i + 1}">${icon('x', 'ico-sm')}</button></div>`).join('');
  $('#capImgsMode').hidden = pics.length < 2;
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
})();
