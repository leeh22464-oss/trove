// Catch 扩展后台：右键菜单 + 快捷键 + 调 capture API
const DEFAULT_SERVER = 'http://127.0.0.1:5173';

async function cfg() {
  const s = await chrome.storage.sync.get(['server', 'token']);
  return { server: (s.server || DEFAULT_SERVER).replace(/\/+$/, ''), token: s.token || '' };
}

async function capture(payload) {
  const { server, token } = await cfg();
  const r = await fetch(server + '/api/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

function notify(title, msg, ok = true) {
  chrome.notifications.create('', {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title, message: msg, priority: 0,
  });
}

async function savePage(tab) {
  try {
    // 优先问 content script 要渲染后正文+图片（含登录态）；拿不到退回只发链接
    let payload = { url: tab.url, title: tab.title };
    try {
      const c = await chrome.tabs.sendMessage(tab.id, { type: 'getContent' });
      if (c && (c.text || c.images?.length)) payload = { ...payload, text: c.text, images: c.images, source: 'extension-page' };
    } catch { /* 页面无 content script（如 chrome:// 页）→ 只发链接 */ }
    const r = await capture(payload);
    notify('已保存到 Catch', r.count ? '页面已入收件箱' : '已存在相同内容', true);
  } catch (e) { notify('保存失败', String(e.message || e), false); }
}

async function saveSelection(tab, text) {
  try {
    const r = await capture({ text: text || '', url: tab.url, title: tab.title, source: 'extension-selection' });
    notify('已保存选区', r.count ? '已入收件箱' : '已存在相同内容', true);
  } catch (e) { notify('保存失败', String(e.message || e), false); }
}

async function saveImage(tab, srcUrl) {
  try {
    const r = await capture({ url: srcUrl, title: tab.title, source: 'extension-image' });
    notify('已保存图片链接', '已入收件箱', true);
  } catch (e) { notify('保存失败', String(e.message || e), false); }
}

// 右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'catch-page', title: '保存页面到 Catch', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'catch-sel', title: '保存选区到 Catch', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'catch-img', title: '保存图片到 Catch', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'catch-link', title: '保存链接到 Catch', contexts: ['link'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'catch-page') await savePage(tab);
  else if (info.menuItemId === 'catch-sel') await saveSelection(tab, info.selectionText);
  else if (info.menuItemId === 'catch-img') await saveImage(tab, info.srcUrl);
  else if (info.menuItemId === 'catch-link') await saveSelection(tab, info.linkUrl);
});

// 快捷键
chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (cmd === 'save-page') await savePage(tab);
  else if (cmd === 'save-selection') {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    }).catch(() => [{}]);
    if (result && result.trim()) await saveSelection(tab, result);
    else await savePage(tab);
  }
});

// 供 popup 调用
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'xhsNote') {
    // 在页面主世界读小红书状态：拿到当前帖子全部原图（无需翻页，不混入信息流）
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id }, world: 'MAIN', args: [msg.noteId],
      func: (noteId) => {
        const un = (v) => (v && typeof v === 'object' && ('_value' in v || '__v_isRef' in v)) ? (v._value ?? v.value) : v;
        const map = un(un(window.__INITIAL_STATE__?.note)?.noteDetailMap) || {};
        const entry = un(map[noteId]) || Object.values(map).map(un).reverse().find(e => un(e?.note)?.imageList);
        const note = un(entry?.note);
        if (!note) return null;
        const list = un(note.imageList) || [];
        const images = list.map((im) => {
          im = un(im) || {};
          const info = (un(im.infoList) || []).map(un);
          return im.urlDefault || info.find(i => i?.imageScene === 'WB_DFT')?.url || im.url || im.urlPre || info[0]?.url || '';
        }).filter(Boolean).map(u => u.replace(/^\/\//, 'https://').replace(/^http:/, 'https:'));
        return { title: note.title || '', desc: note.desc || '', images };
      },
    }).then(([r] = []) => sendResponse(r?.result || null)).catch(() => sendResponse(null));
    return true;
  }
  if (msg.type === 'capture') {
    capture(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'test') {
    cfg().then(async ({ server, token }) => {
      try {
        const r = await fetch(server + '/api/settings', { headers: { Authorization: 'Bearer ' + token } });
        sendResponse({ ok: r.ok, status: r.status });
      } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
    });
    return true;
  }
});
