const $ = (s) => document.querySelector(s);
const stat = (msg, ok) => { const el = $('#stat'); el.textContent = msg; el.className = 'stat ' + (ok === undefined ? '' : ok ? 'ok' : 'err'); };

async function tab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function getSelection() {
  const t = await tab();
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.getSelection().toString() });
    return result || '';
  } catch { return ''; }
}

function send(payload) {
  return new Promise((res) => chrome.runtime.sendMessage({ type: 'capture', payload }, res));
}

async function doCapture(payload, what) {
  stat('保存中…');
  const r = await send(payload);
  if (r?.error) stat('失败：' + r.error, false);
  else if (r?.count) stat(what + '已保存到收件箱', true);
  else stat('已存在相同内容', true);
}

(async () => {
  const t = await tab();
  $('#meta').textContent = t ? (t.title || t.url) : '无法读取页面';
  $('#opts').onclick = () => chrome.runtime.openOptionsPage();

  $('#savePage').onclick = () => doCapture({ url: t.url, title: t.title }, '页面');
  $('#saveText').onclick = () => {
    const txt = $('#text').value.trim();
    if (!txt) { stat('先在文本框里粘点内容', false); return; }
    doCapture({ text: txt, url: t.url, title: t.title, source: 'extension' }, '文本');
  };
  $('#saveSel').onclick = async () => {
    const sel = await getSelection();
    if (!sel.trim()) { stat('页面里没选中内容', false); return; }
    doCapture({ text: sel, url: t.url, title: t.title, source: 'extension-selection' }, '选区');
  };
})();
