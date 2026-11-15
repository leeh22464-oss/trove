import { $, $$, esc, icon, get, post, patch, put, api, renderMd, markdownToText, copyText, toast, timeAgo, KIND_LABEL, confirmDialog } from './lib.js';
import { state, emit } from './state.js';

let item = null;
let editing = false;
let draft = '';

export const current = () => item;

const SOURCE_TYPE = { manual: '手动', web: '网页', image: '图片', import: '导入' };

function placeholders(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}|\[([^\[\]\n]{1,20})\]|\{([^{}\n]{1,20})\}/g)) set.add((m[1] || m[2] || m[3]).trim());
  return [...set].slice(0, 12);
}

export function renderEmpty() {
  item = null; editing = false;
  $('#detail').innerHTML = `<div class="detail-empty"><div>
    <h2>选一条看看</h2>
    <p>左侧选中条目后，这里显示正文，并可以一键复制。</p>
    <div class="hints">
      <div><kbd>j</kbd><kbd>k</kbd><span>上下切换</span></div>
      <div><kbd>c</kbd><span>复制当前正文</span></div>
      <div><kbd>/</kbd><span>聚焦搜索</span></div>
      <div><kbd>Ctrl</kbd><kbd>V</kbd><span>在任何位置粘贴即可抓取</span></div>
    </div></div></div>`;
}

export async function showItem(id) {
  let it;
  try { it = await get(`/api/items/${id}`); } catch (e) { toast(e.message, { error: true }); return; }
  if (it.error) { renderEmpty(); toast('该条目已不存在', { error: true }); emit('refresh'); return; }
  item = it; editing = false;
  render();
}

export async function refreshCurrent() {
  if (!item) return;
  const id = item.id;
  try {
    const it = await get(`/api/items/${id}`);
    if (it.error || (item && item.id !== id)) return;
    if (editing) { item = { ...item, processing: it.processing }; return; }
    // 没有实质变化就不重渲，避免详情栏动画每轮轮询重放
    const same = it.updated_at === item.updated_at && it.processing === item.processing
      && (it.content || '') === (item.content || '') && (it.title || '') === (item.title || '');
    if (same) { item = it; return; }
    item = it; render(false);
  } catch { /* 忽略瞬时失败 */ }
}

function tagChip(t) {
  const ai = t.source === 'ai';
  return `<span class="tag-chip${ai ? ' ai' : ''}" title="${ai ? 'AI 建议并经你确认' : '手动添加'}">#${esc(t.name)}<button class="x" type="button" data-untag="${esc(t.name)}" aria-label="移除标签 ${esc(t.name)}">${icon('x', 'ico-sm')}</button></span>`;
}

function removedHtml(list) {
  if (!list.length) return '';
  const WHY = { llm: 'AI 识别为冗余', trailing_hashtags: '末尾话题标签', tracking_params: '链接追踪参数', ui_noise: '界面残留（点赞收藏等）', interaction_count: '互动数字', social_header: '作者/社媒抬头', timestamp: '时间戳', decoration: '分隔装饰' };
  return `<details class="sect" id="secRemoved"><summary><span class="twirl">${icon('chevron-right')}</span><span class="grow">已清洗掉 ${list.length} 处</span><button class="btn sm" type="button" id="btnRestoreRaw">还原原文</button></summary>
    <div class="inner"><ul class="removed-list">${list.map((r) => `<li><span class="why">${esc(WHY[r.reason] || r.reason || '冗余')}</span>${esc(r.text)}</li>`).join('')}</ul>
    <p class="hint" style="margin-top:8px;color:var(--c-text-3);font-size:12px">原文始终保留。「还原原文」会把正文换回抓取时的原始内容，并保存一个版本，可以再回滚。</p></div></details>`;
}

function render(animate = true) {
  const it = item;
  const trash = it.status === 'trash';
  const vars = placeholders(it.content);
  const src = it.source_url ? `<a href="${esc(it.source_url)}" target="_blank" rel="noopener noreferrer">${esc(it.source_platform || it.source_url)}</a>` : (SOURCE_TYPE[it.source_type] || '');
  const imgs = (it.assets || []).filter((a) => a.sha256);
  const processing = it.processing ? `<span class="busy">${icon('loader', 'ico-sm')} 正在处理：${esc(it.processing)}</span>` : '';

  $('#detail').innerHTML = `<div class="d-wrap${animate ? ' d-enter' : ''}">
    <div class="d-top">
      <button class="icon-btn only-narrow" type="button" id="btnBack" aria-label="返回列表">${icon('arrow-left')}</button>
      ${editing ? `<input class="d-title-input" id="edTitle" value="${esc(it.title)}" aria-label="标题">` : `<h1 id="dTitle"${trash ? '' : ' class="editable" tabindex="0" title="点击修改标题"'}>${esc(it.title || '(未命名)')}</h1>`}
      <div class="d-actions">
        ${trash ? `<button class="btn primary" type="button" id="btnRestore">${icon('undo-2')}恢复</button>`
          : `<button class="icon-btn" type="button" id="btnFav" aria-pressed="${!!it.favorite}" aria-label="收藏">${icon('star')}</button>
        <button class="btn primary" type="button" id="btnCopy">${icon('copy')}复制</button>
        <button class="icon-btn" type="button" id="btnMore" aria-label="更多操作" aria-haspopup="true">${icon('ellipsis')}</button>`}
      </div>
    </div>
    <div class="d-meta">
      <span class="kind" data-k="${esc(it.kind)}">${esc(KIND_LABEL[it.kind] || it.kind)}</span>
      ${src ? `<span>${src}</span>` : ''}
      <span>更新于 ${timeAgo(it.updated_at)}</span>
      ${it.use_count ? `<span>已复制 ${it.use_count} 次</span>` : ''}
      ${processing}
    </div>
    ${it.summary && !editing ? `<p class="d-summary">${esc(it.summary)}</p>` : ''}
    <div class="d-tags" id="dTags">${(it.tags || []).map(tagChip).join('')}${trash ? '' : `<input class="tag-add" id="tagAdd" placeholder="+ 添加标签" aria-label="添加标签" maxlength="60">`}</div>
    ${imgs.length ? `<div class="d-images">${imgs.map((a) => `<figure><a href="/api/assets/${a.id}/file" target="_blank" rel="noopener"><img src="/api/assets/${a.id}/file" alt="${esc(it.title)} 的配图" loading="lazy"></a><figcaption>${a.ocr_state === 'done' ? '已识别文字' : a.ocr_state === 'pending' ? '识别中…' : esc(a.ocr_state || '')}</figcaption></figure>`).join('')}</div>` : ''}
    <div class="body-box">
      <div class="bar"><span class="grow">正文</span>
        ${trash ? '' : editing
          ? `<button class="btn sm" type="button" id="btnCancelEdit">取消</button><button class="btn sm primary" type="button" id="btnSaveEdit">保存</button>`
          : `<button class="btn sm ghost" type="button" id="btnEdit">${icon('pencil', 'ico-sm')}编辑</button>`}
      </div>
      ${editing ? `<textarea class="md-edit" id="edBody" aria-label="正文">${esc(draft || it.content)}</textarea>` : `<div class="md" id="mdBody">${renderMd(it.content)}</div>`}
    </div>
    ${vars.length && !editing ? `<div class="vars"><span>变量</span>${vars.map((v) => `<code>${esc(v)}</code>`).join('')}</div>` : ''}
    ${it.kind === 'skill' ? `<div id="skillCheck"></div>` : ''}
    ${removedHtml(it.removed || [])}
    <details class="sect" id="secVer"><summary><span class="twirl">${icon('chevron-right')}</span><span class="grow">版本历史</span></summary><div class="inner" id="verBox"><span class="hint">展开后加载…</span></div></details>
    ${(it.related?.length || it.backlinks?.length) ? `<details class="sect" open><summary><span class="twirl">${icon('chevron-right')}</span><span class="grow">相关条目</span></summary><div class="inner"><ul class="rows">
      ${(it.related || []).map((r) => `<li><button class="linklike grow" type="button" data-open="${r.id}">${esc(r.title)}</button><span class="kind" data-k="${esc(r.kind)}">${esc(KIND_LABEL[r.kind] || r.kind)}</span><span style="font-size:12px;color:var(--c-text-3)">共 ${r.shared} 个标签</span></li>`).join('')}
      ${(it.backlinks || []).map((r) => `<li><button class="linklike grow" type="button" data-open="${r.id}">${esc(r.title)}</button><span style="font-size:12px;color:var(--c-text-3)">引用了本条</span></li>`).join('')}
    </ul></div></details>` : ''}
    ${it.collections?.length ? `<div class="d-meta" style="margin-top:16px">集合：${it.collections.map((c) => esc(c.name)).join('、')}</div>` : ''}
  </div>`;
  bind();
  if (it.kind === 'skill') checkSkill();
}

async function checkSkill() {
  const box = $('#skillCheck');
  if (!box || !item) return;
  try {
    const r = await post('/api/skill/validate', { content: item.content });
    const errs = r.errors || [], warns = r.warnings || [];
    box.innerHTML = `<div class="sect" style="padding:12px 16px"><strong>SKILL.md 校验</strong>
      ${!errs.length && !warns.length ? `<p class="status-line ok" style="margin-top:6px">${icon('circle-check')}结构合规</p>`
        : `<ul class="skill-issues">${errs.map((e) => `<li class="e">${icon('triangle-alert', 'ico-sm')} ${esc(e.message || e)}</li>`).join('')}${warns.map((w) => `<li class="w">${icon('info', 'ico-sm')} ${esc(w.message || w)}</li>`).join('')}</ul>`}
      <div style="margin-top:8px"><a class="btn sm" href="/api/items/${item.id}/export-skill">${icon('download', 'ico-sm')}导出 zip</a></div></div>`;
  } catch { box.innerHTML = ''; }
}

async function loadVersions() {
  const box = $('#verBox');
  if (!box || !item) return;
  const list = await get(`/api/items/${item.id}/versions`);
  if (!list.length) { box.innerHTML = '<span class="hint">暂无历史版本。每次编辑或应用方案前都会自动保存。</span>'; return; }
  const REASON = { edit: '编辑', plan_apply: '应用分类方案', restore_raw: '还原原文', reclean: '重新清洗', classify: 'AI 整理', 'pre-rollback': '回滚前', batch_tag: '批量打标签', batch_status: '批量改状态' };
  box.innerHTML = `<ul class="rows">${list.map((v) => `<li><span class="grow">${esc(REASON[v.reason] || v.reason)} · ${timeAgo(v.created_at)}</span><button class="btn sm" type="button" data-rollback="${v.id}">回滚到此</button><button class="btn sm ghost" type="button" data-ver="${v.id}">对比</button></li>`).join('')}</ul><div id="verDiff"></div>`;
}

async function showDiff(vid) {
  const d = await get(`/api/versions/${vid}`);
  const lines = d.diff.map((l) => `<div class="${l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : ''}">${esc(l.text) || '&nbsp;'}</div>`).join('');
  $('#verDiff').innerHTML = `<p style="margin:12px 0 4px;font-size:12px;color:var(--c-text-3)">删除线为该版本有、当前没有的内容；绿色为当前新增。</p><div class="diff">${lines}</div>
    <div style="margin-top:8px"><button class="btn sm" type="button" id="btnRollback" data-ver="${vid}">回滚到这个版本</button></div>`;
}

function bind() {
  const it = item;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };

  on('#btnBack', () => emit('back'));
  on('#btnCopy', () => copyItem());
  on('#btnFav', async () => {
    const next = !it.favorite;
    await patch(`/api/items/${it.id}`, { favorite: next });
    it.favorite = next ? 1 : 0;
    const b = $('#btnFav'); if (b) b.setAttribute('aria-pressed', String(next));
    emit('refresh');
  });
  on('#btnRestore', async () => { await post(`/api/items/${it.id}/restore`); toast('已恢复到收件箱'); emit('refresh'); await showItem(it.id); });
  on('#btnEdit', () => { editing = true; draft = ''; render(); $('#edBody')?.focus(); });
  on('#btnCancelEdit', () => { editing = false; draft = ''; render(); });
  on('#btnSaveEdit', async () => {
    const content = $('#edBody').value, title = $('#edTitle').value.trim();
    await patch(`/api/items/${it.id}`, title && title !== it.title ? { content, title } : { content });
    editing = false; draft = '';
    toast('已保存，旧版本在「版本历史」里'); emit('refresh'); await showItem(it.id);
  });
  on('#btnRestoreRaw', async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!(await confirmDialog('还原原文', '正文会换回抓取时的原始内容，当前内容会存为一个版本，可再回滚。', '还原'))) return;
    await post(`/api/items/${it.id}/restore-raw`);
    toast('已还原原文', { action: '撤销', onAction: async () => { await rollbackLatest(it.id); } });
    emit('refresh'); await showItem(it.id);
  });
  on('#btnMore', (e) => openMore(e.currentTarget));

  // 标题原地编辑：点击变输入框，回车/失焦保存，Esc 取消
  const h1 = $('#dTitle.editable');
  const editTitle = () => {
    const inp = document.createElement('input');
    inp.className = 'd-title-input'; inp.value = it.title || ''; inp.setAttribute('aria-label', '标题'); inp.maxLength = 200;
    h1.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (save && v && v !== it.title) {
        await patch(`/api/items/${it.id}`, { title: v });
        it.title = v; toast('标题已修改，之后 AI 整理不会再改它');
        emit('refresh');
      }
      render(false);
    };
    inp.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false);
    };
    inp.onblur = () => finish(true);
  };
  if (h1) { h1.onclick = editTitle; h1.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); editTitle(); } }; }

  const add = $('#tagAdd');
  if (add) add.onkeydown = async (e) => {
    if (e.key !== 'Enter' || !add.value.trim() || e.isComposing) return;
    const tags = [...(it.tags || []).map((t) => t.name), add.value.trim()];
    await patch(`/api/items/${it.id}`, { tags });
    emit('refresh'); await showItem(it.id);
  };
  $('#dTags').onclick = async (e) => {
    const b = e.target.closest('[data-untag]');
    if (!b) return;
    await patch(`/api/items/${it.id}`, { tags: (it.tags || []).map((t) => t.name).filter((n) => n !== b.dataset.untag) });
    emit('refresh'); await showItem(it.id);
  };
  $$('[data-open]').forEach((b) => { b.onclick = () => emit('select', Number(b.dataset.open)); });
  $('#secVer')?.addEventListener('toggle', (e) => { if (e.target.open) loadVersions(); });
  $('#detail').onclick = async (e) => {
    const rb = e.target.closest('[data-rollback]');
    if (rb) {
      await post(`/api/versions/${rb.dataset.rollback}/restore`);
      toast('已回滚到该版本'); emit('refresh'); await showItem(it.id);
      return;
    }
    const v = e.target.closest('[data-ver]');
    if (v) await showDiff(v.dataset.ver);
  };
}

async function rollbackLatest(id) {
  const list = await get(`/api/items/${id}/versions`);
  const pre = list.find((v) => v.reason === 'restore_raw');
  if (pre) { await post(`/api/versions/${pre.id}/restore`); emit('refresh'); await showItem(id); }
}

export async function copyItem() {
  if (!item || item.status === 'trash') return;
  const ok = await copyText(markdownToText(item.content));
  if (!ok) { toast('浏览器拒绝了复制，请手动选中复制', { error: true }); return; }
  const r = await post(`/api/items/${item.id}/copy`);
  item.use_count = r.use_count;
  toast('已复制到剪贴板');
  const btn = $('#btnCopy');
  if (btn) { btn.innerHTML = `${icon('check')}已复制`; setTimeout(() => { if ($('#btnCopy')) $('#btnCopy').innerHTML = `${icon('copy')}复制`; }, 1500); }
}

export async function toggleFavorite() { $('#btnFav')?.click(); }

function pickImages(cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif'; inp.multiple = true; inp.hidden = true;
  document.body.append(inp);
  inp.onchange = () => { cb([...inp.files]); inp.remove(); };
  inp.click();
}

function openMore(anchor) {
  document.getElementById('moreMenu')?.remove();
  const it = item;
  const menu = document.createElement('div');
  menu.id = 'moreMenu';
  menu.setAttribute('role', 'menu');
  menu.style.cssText = 'position:fixed;z-index:70;min-width:200px;padding:6px;background:var(--c-raised);border:.5px solid var(--c-line);border-radius:var(--r-l);box-shadow:0 1px 6px rgba(0,0,0,.12)';
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`; menu.style.right = `${innerWidth - r.right}px`;
  const items = [
    ['kind', '改类型…', 'tag'], ['collection', '加入集合…', 'folder'], ['addimg', '添加图片…', 'image'], ['reclean', '重新清洗…', 'sparkles'], ['reclassify', '重新生成建议标签', 'refresh-cw'],
    ['archive', it.status === 'archived' ? '取消归档' : '归档', 'archive'], ['trash', '移到回收站', 'trash-2'],
  ];
  menu.innerHTML = items.map(([k, l, ic]) => `<button class="nav-item" role="menuitem" type="button" data-act="${k}">${icon(ic)}<span>${l}</span></button>`).join('');
  document.body.append(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', away, true); };
  const away = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', away, true));
  menu.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    close();
    const act = b.dataset.act;
    if (act === 'trash') {
      await patch(`/api/items/${it.id}`, { status: 'trash' });
      toast('已移到回收站', { action: '撤销', onAction: async () => { await post(`/api/items/${it.id}/restore`); emit('refresh'); } });
      emit('deselect'); emit('refresh');
    } else if (act === 'archive') {
      await patch(`/api/items/${it.id}`, { status: it.status === 'archived' ? 'inbox' : 'archived' });
      toast(it.status === 'archived' ? '已取消归档' : '已归档'); emit('refresh'); await showItem(it.id);
    } else if (act === 'reclassify') {
      await post(`/api/items/${it.id}/reclassify`);
      toast('已排队，完成后可在「分类方案」里查看建议'); emit('refresh');
    } else if (act === 'reclean') {
      if (!(await confirmDialog('重新清洗', '用抓取时的原文和全部图片识别文字重新生成正文，去掉噪音后再让 AI 重新排版。当前正文会存为一个版本，可在「版本历史」回滚。', '重新清洗'))) return;
      await post(`/api/items/${it.id}/reclean`);
      toast('已重新清洗，AI 排版中…', { action: '撤销', onAction: async () => {
        const v = (await get(`/api/items/${it.id}/versions`)).find((x) => x.reason === 'reclean');
        if (v) { await post(`/api/versions/${v.id}/restore`); emit('refresh'); await showItem(it.id); }
      } });
      emit('refresh'); await showItem(it.id);
    } else if (act === 'addimg') {
      pickImages(async (files) => {
        const fd = new FormData();
        for (const f of files) fd.append('images', f, f.name || 'img.png');
        const r = await api('POST', `/api/items/${it.id}/assets`, fd);
        toast(r.added ? `已加 ${r.added} 张图` : '没加成功', r.added ? {} : { error: true });
        emit('refresh'); await showItem(it.id);
      });
    } else if (act === 'kind') emit('dialog', 'kind');
    else if (act === 'collection') emit('dialog', 'collection');
  };
}
