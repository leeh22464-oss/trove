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

const CLIPS_KEY = 'catch.selectionClips';
let clips = [];
async function loadClips() {
  const data = await chrome.storage.local.get(CLIPS_KEY);
  clips = Array.isArray(data[CLIPS_KEY]) ? data[CLIPS_KEY] : [];
  renderClips();
}
async function saveClips() { await chrome.storage.local.set({ [CLIPS_KEY]: clips }); renderClips(); }
function renderClips() {
  const list = $('#clipList');
  $('#clipCount').textContent = `${clips.length} 段`;
  list.innerHTML = clips.length ? clips.map((c, i) => `<label class="clip-row"><input type="checkbox" data-clip="${i}" checked><span style="flex:1;min-width:0"><p></p><span class="clip-source"></span></span><button type="button" data-rm-clip="${i}" aria-label="移除片段">×</button></label>`).join('') : '<div class="clips-empty">在网页选中文字后点「暂存选区」</div>';
  clips.forEach((c, i) => {
    const row = list.querySelectorAll('.clip-row')[i];
    row.querySelector('p').textContent = c.text;
    row.querySelector('.clip-source').textContent = c.title || c.url || '';
  });
  $('#sendClips').disabled = clips.length === 0;
  $('#clearClips').disabled = clips.length === 0;
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

  await loadClips();
  $('#savePage').onclick = () => doCapture({ url: t.url, title: t.title }, '页面');
  $('#saveText').onclick = () => {
    const txt = $('#text').value.trim();
    if (!txt) { stat('先在文本框里粘点内容', false); return; }
    doCapture({ text: txt, url: t.url, title: t.title, source: 'extension' }, '文本');
  };
  $('#saveSel').onclick = async () => {
    const sel = await getSelection();
    if (!sel.trim()) { stat('页面里没选中内容', false); return; }
    const normalized = sel.trim();
    const existing = clips.find(c => c.text.trim() === normalized);
    if (existing) { stat('这段文字已经暂存', false); return; }
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'stashSelection', clip: { text: normalized, url: t.url, title: t.title } }, res));
    if (r?.error) { stat('暂存失败：' + r.error, false); return; }
    if (r?.duplicate) { stat('这段文字已经暂存', false); return; }
    await loadClips();
    stat(`已暂存第 ${clips.length} 段，可继续选择文字`, true);
  };
  $('#clipList').onclick = async (e) => {
    const b = e.target.closest('[data-rm-clip]');
    if (!b) return;
    clips.splice(Number(b.dataset.rmClip), 1);
    await saveClips();
  };
  $('#clearClips').onclick = async () => { clips = []; await saveClips(); stat('暂存区已清空', true); };
  $('#sendClips').onclick = async () => {
    const selected = [...$('#clipList').querySelectorAll('[data-clip]:checked')].map(el => clips[Number(el.dataset.clip)]).filter(Boolean);
    if (!selected.length) { stat('先勾选要合并的文字段', false); return; }
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'openCatchWithClips', clips: selected }, res));
    if (r?.error) { stat('打开 Catch 失败：' + r.error, false); return; }
    stat(`已发送 ${selected.length} 段，正在打开 Catch`, true);
  };
})();
