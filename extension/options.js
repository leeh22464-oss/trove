const $ = (s) => document.querySelector(s);
const stat = (msg, ok) => { const el = $('#stat'); el.textContent = msg; el.className = ok === undefined ? '' : ok ? 'ok' : 'err'; };

(async () => {
  const s = await chrome.storage.sync.get(['server', 'token']);
  $('#server').value = s.server || 'http://127.0.0.1:5173';
  $('#token').value = s.token || '';
})();

$('#save').onclick = async () => {
  await chrome.storage.sync.set({ server: $('#server').value.trim(), token: $('#token').value.trim() });
  stat('已保存', true);
};

$('#test').onclick = () => {
  stat('测试中…');
  chrome.storage.sync.set({ server: $('#server').value.trim(), token: $('#token').value.trim() }, () => {
    chrome.runtime.sendMessage({ type: 'test' }, (r) => {
      if (r?.ok) stat('连接成功，token 有效', true);
      else stat('失败：' + (r?.error || ('HTTP ' + r?.status) || '无法连接'), false);
    });
  });
};
