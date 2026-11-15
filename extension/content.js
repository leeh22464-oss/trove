// Catch 页面浮球：右下角小圆钮，可拖拽，抓当前页正文+图片（含登录态）
(() => {
  if (window.top !== window) return; // 只在顶层框架注入，iframe 不挂（防重影）
  if (document.getElementById('__catch-fab')) return;

  const HOST = location.hostname;
  if (['127.0.0.1', 'localhost'].includes(HOST)) return; // Catch 自身页不挂浮球

  const fab = document.createElement('button');
  fab.id = '__catch-fab';
  fab.title = '保存到 Catch（可拖拽）';
  fab.setAttribute('aria-label', '保存到 Catch');
  fab.innerHTML = `<svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#161615"/><path d="M21.7 11.2A7.4 7.4 0 1 0 21.7 20.8" fill="none" stroke="#fafafa" stroke-width="2.8" stroke-linecap="round"/><circle cx="22.6" cy="16" r="2.3" fill="#90e203"/></svg>`;
  document.documentElement.appendChild(fab);

  // ---- 拖拽（PointerEvent，移动 <5px 视为点击）----
  let drag = null, moved = false;
  fab.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, r: fab.getBoundingClientRect() };
    moved = false;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
    if (!moved) return;
    const left = Math.min(Math.max(drag.r.left + dx, 4), innerWidth - 44);
    const top = Math.min(Math.max(drag.r.top + dy, 4), innerHeight - 44);
    fab.style.left = left + 'px'; fab.style.top = top + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  });
  fab.addEventListener('pointerup', () => { drag = null; });

  // ---- 菜单 ----
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target) && e.target !== fab) closeMenu(); }, true);

  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.id = '__catch-menu';
    const r = fab.getBoundingClientRect();
    menu.style.left = Math.min(r.left, innerWidth - 190) + 'px';
    menu.style.top = Math.max(r.top - 140, 8) + 'px';
    const sel = (window.getSelection() || '').toString().trim();
    menu.innerHTML = `
      <button data-a="page">存当前页（正文+图）</button>
      ${sel ? `<button data-a="sel">存选中 ${sel.length > 10 ? sel.slice(0, 10) + '…' : sel}</button>` : ''}
      <button data-a="open">打开 Catch</button>`;
    document.documentElement.appendChild(menu);
    menu.onclick = async (e) => {
      const a = e.target.dataset?.a;
      if (!a) return;
      closeMenu();
      if (a === 'open') { window.open('http://127.0.0.1:5173', '_blank'); return; }
      toast('抓取中…');
      const payload = await buildPayload(a);
      toast(`抓取中…（${payload.images.length} 张图）`);
      const r = await chrome.runtime.sendMessage({ type: 'capture', payload });
      toast(r?.error ? '保存失败：' + r.error : (r?.count ? '已保存到 Catch' : '已存在相同内容'));
    };
  }

  // ---- 页面内容提取（浏览器渲染后的 DOM，含登录态内容）----
  const MAX_IMGS = 50;
  const isXhs = /(^|\.)xiaohongshu\.com$/.test(HOST);
  const xhsNoteId = () => (location.pathname.match(/\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]{24})/) || [])[1] || '';

  async function buildPayload(mode) {
    const url = location.href, title = document.title;
    const sel = (window.getSelection() || '').toString().trim();
    if (isXhs) {
      // 小红书：读页面状态里当前帖子的完整图片列表（不用翻页，也不会混入背后信息流）
      const note = await chrome.runtime.sendMessage({ type: 'xhsNote', noteId: xhsNoteId() }).catch(() => null);
      const root = scope();
      const nTitle = note?.title || root.querySelector('#detail-title')?.innerText || title;
      const nDesc = note?.desc || root.querySelector('#detail-desc')?.innerText || '';
      const images = note?.images?.length ? note.images.slice(0, MAX_IMGS) : collectImgs(root);
      return { text: mode === 'sel' && sel ? sel : [nTitle, nDesc].filter(Boolean).join('\n\n'), url, title: nTitle, source: 'extension-xhs', images };
    }
    const root = scope();
    if (mode === 'sel') return { text: sel, url, title, source: 'extension-selection', images: collectImgs(root) };
    return { text: extractText(root), url, title, source: 'extension-page', images: collectImgs(root) };
  }

  // 有弹窗（帖子详情浮层）时只在弹窗内取内容，避免抓到背后列表页
  function scope() {
    const modal = [...document.querySelectorAll('#noteContainer, .note-container, .note-detail-mask, [role="dialog"], [aria-modal="true"]')]
      .find(el => el.offsetWidth > 300 && el.offsetHeight > 300);
    return modal || document;
  }

  function extractText(root) {
    const base = root === document ? document.body : root;
    const cand = base.querySelector('article, main, [role="main"], #content, .content, .note-content, .desc');
    const t = (cand || base).innerText || '';
    return t.replace(/\n{3,}/g, '\n\n').trim().slice(0, 30000);
  }

  function collectImgs(root) {
    const urls = new Set();
    const add = (u) => { if (u && /^https?:/i.test(u)) urls.add(u); };
    if (root === document) document.querySelectorAll('meta[property^="og:image"], meta[name="twitter:image"]').forEach(m => add(m.content));
    // swiper 循环模式会复制首尾 slide，跳过 duplicate
    root.querySelectorAll('img').forEach((im) => {
      if (im.closest('.swiper-slide-duplicate')) return;
      const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
      if (w >= 200 && h >= 200) add(im.currentSrc || im.src);
    });
    root.querySelectorAll('[style*="background-image"]').forEach((el) => {
      if (el.closest('.swiper-slide-duplicate')) return;
      const m = (el.style.backgroundImage || '').match(/url\("?(https?:[^")]+)/);
      if (m && el.offsetWidth >= 200 && el.offsetHeight >= 200) add(m[1]);
    });
    return [...urls].slice(0, MAX_IMGS);
  }

  function toast(msg) {
    let t = document.getElementById('__catch-toast');
    if (!t) { t = document.createElement('div'); t.id = '__catch-toast'; document.documentElement.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('on'), 2600);
  }

  fab.onclick = (e) => { e.stopPropagation(); if (moved) { moved = false; return; } menu ? closeMenu() : openMenu(); };

  // background 右键菜单/快捷键也要正文+图（而不只是链接）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getContent') { buildPayload('page').then(sendResponse); return true; }
  });
})();
