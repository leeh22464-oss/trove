import { $, $$, esc, icon, get, post, put, patch, api, toast, openDialog, closeDialog, copyText, confirmDialog } from './lib.js';
import { state, emit } from './state.js';
import { current } from './detail.js';

const field = (id, label, value, { type = 'text', hint = '', ph = '' } = {}) =>
  `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
const check = (id, label, on) => `<div class="field check"><input id="${id}" type="checkbox" ${on === '1' ? 'checked' : ''}><label for="${id}">${label}</label></div>`;

export async function openSettings() {
  const s = await get('/api/settings');
  state.settings = s;
  const secretHint = (k) => (s[k + '_set'] === '1' ? '已设置。留空或保持 **** 不会覆盖。' : '尚未设置。');
  openDialog({
    title: '设置', wide: true,
    body: `
    <div class="sec-title">AI（OpenAI 兼容接口）</div>
    ${field('s_llm_base_url', 'Base URL', s.llm_base_url, { ph: 'https://api.deepseek.com' })}
    ${field('s_llm_model', '模型', s.llm_model, { ph: 'deepseek-chat' })}
    ${field('s_llm_api_key', 'API Key', s.llm_api_key, { type: 'password', hint: secretHint('llm_api_key') + ' 建议改用环境变量 CATCH_LLM_API_KEY，不写进数据库。' })}
    <div class="field"><label for="s_llm_custom_prompt">附加指令（可选）</label><textarea id="s_llm_custom_prompt" placeholder="例如：标签尽量用中文；把英文 prompt 保留原文">${esc(s.llm_custom_prompt)}</textarea></div>
    <div style="display:flex;gap:12px;align-items:center"><button class="btn" type="button" id="testLlm">测试连接</button><span id="llmRes" class="status-line"></span></div>

    <div class="sec-title">图片文字识别（OCR）</div>
    ${field('s_ocr_chain', '识别链路', s.ocr_chain, { hint: '按顺序尝试，前一个失败自动用下一个。可选 paddle-hosted、paddle-selfhost、vision-llm。' })}
    ${field('s_paddle_token', 'PaddleOCR 托管 token', s.paddle_token, { type: 'password', hint: secretHint('paddle_token') + ' 图片会上传到百度 AI Studio，有每日免费额度。建议用环境变量 CATCH_PADDLE_TOKEN。' })}
    ${field('s_paddle_selfhost_url', '自建 PaddleOCR 地址', s.paddle_selfhost_url, { hint: '图片不出本机。用 paddlex --serve 启动。' })}
    <div style="display:flex;gap:12px;align-items:center"><button class="btn" type="button" id="testOcr">检查配置</button><span id="ocrRes" class="status-line"></span></div>

    <div class="sec-title">自动处理</div>
    ${check('s_auto_clean', '抓取后自动清洗冗余', s.auto_clean)}
    ${check('s_auto_classify', '抓取后自动生成建议标签（不会直接打标签，需经「分类方案」确认）', s.auto_classify)}
    ${check('s_auto_ocr', '图片自动识别文字', s.auto_ocr)}

    <div class="sec-title">Obsidian</div>
    ${field('s_obsidian_vault', 'Vault 目录', s.obsidian_vault, { ph: 'D:\\notes\\vault', hint: '导出时直接写入此目录；留空则下载 zip。' })}

    <div class="sec-title">抓取令牌</div>
    <div class="field"><span class="lbl">用于浏览器扩展或脚本跨源调用，放在 Authorization: Bearer 后面</span>
      <div style="display:flex;gap:8px"><input type="password" id="s_capture_token" value="${esc(s.capture_token)}" readonly style="flex:1;min-height:36px;padding:0 12px;border:1px solid var(--c-line-strong);border-radius:8px;background:var(--c-bg)">
      <button class="btn" type="button" id="cpTok">复制</button><button class="btn danger" type="button" id="rstTok">重置</button></div></div>`,
    foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="saveSet">保存</button>`,
    onMount: (d) => {
      const collect = () => Object.fromEntries(['llm_base_url', 'llm_model', 'llm_api_key', 'llm_custom_prompt', 'ocr_chain', 'paddle_token', 'paddle_selfhost_url', 'obsidian_vault']
        .map((k) => [k, $('#s_' + k, d).value])
        .concat(['auto_clean', 'auto_classify', 'auto_ocr'].map((k) => [k, $('#s_' + k, d).checked ? '1' : '0'])));
      const run = async (btnId, resId, fn) => {
        const b = $(btnId, d), r = $(resId, d);
        b.disabled = true; r.className = 'status-line'; r.textContent = '测试中…';
        try { await put('/api/settings', collect()); const out = await fn(); r.className = `status-line ${out.ok ? 'ok' : 'bad'}`; r.textContent = out.text; }
        catch (e) { r.className = 'status-line bad'; r.textContent = e.message; }
        finally { b.disabled = false; }
      };
      $('#testLlm', d).onclick = () => run('#testLlm', '#llmRes', async () => {
        const r = await post('/api/settings/test-llm');
        return r.ok ? { ok: true, text: `连接正常，耗时 ${r.latencyMs}ms` } : { ok: false, text: r.error || '连接失败' };
      });
      $('#testOcr', d).onclick = () => run('#testOcr', '#ocrRes', async () => {
        const r = await post('/api/settings/test-ocr');
        return { ok: r.results.some((x) => x.ok), text: r.results.map((x) => `${x.name}：${x.ok ? (x.note ? '已配置' : '正常') : x.error}`).join('；') };
      });
      $('#saveSet', d).onclick = async () => {
        try { await put('/api/settings', collect()); state.settings = await get('/api/settings'); toast('设置已保存'); closeDialog(); }
        catch (e) { toast(e.message, { error: true }); }
      };
      $('#cpTok', d).onclick = async () => toast((await copyText($('#s_capture_token', d).value)) ? '令牌已复制' : '复制失败', { error: false });
      $('#rstTok', d).onclick = async () => {
        if (!(await confirmDialog('重置令牌', '旧令牌立即失效，使用它的扩展或脚本需要更新。', '重置', true))) return;
        const r = await post('/api/settings/reset-token');
        toast('令牌已重置'); openSettings(); void r;
      };
    },
  });
}

export function openIo() {
  openDialog({
    title: '导入 / 导出', wide: true,
    body: `
    <div class="sec-title">导出</div>
    <p style="display:flex;flex-wrap:wrap;gap:8px">
      <a class="btn" href="/api/export/json">${icon('download')}完整备份（JSON）</a>
      <a class="btn" href="/api/export/prompts.md">${icon('download')}所有 prompt（Markdown）</a>
      <a class="btn" href="/api/export/obsidian?zip=1">${icon('download')}Obsidian 笔记（zip）</a></p>
    <div class="sec-title">从聊天记录导入</div>
    <p style="color:var(--c-text-2);margin-bottom:8px">支持 ChatGPT 导出的 conversations.json、Claude 导出的 JSON，或直接粘贴的对话文本。系统会挑出像 prompt 的用户消息，由你勾选后入库。</p>
    <div class="field"><label for="chatFile">选择文件</label><input id="chatFile" type="file" accept=".json,.txt,.md"></div>
    <div class="field"><label for="chatText">或粘贴对话文本</label><textarea id="chatText" rows="5" placeholder="user: ……&#10;assistant: ……"></textarea></div>
    <button class="btn" type="button" id="chatParse">解析</button>
    <div id="chatRes" style="margin-top:16px"></div>
    <div class="sec-title">从 Obsidian vault 导入</div>
    ${field('obsDir', 'Vault 目录路径', state.settings.obsidian_vault || '', { ph: 'D:\\notes\\vault' })}
    <button class="btn" type="button" id="obsGo">导入</button> <span id="obsRes" class="status-line"></span>
    <div class="sec-title">从备份恢复</div>
    <div class="field"><label for="jsonFile">选择 catch 导出的 JSON</label><input id="jsonFile" type="file" accept=".json"></div>
    <button class="btn" type="button" id="jsonGo">恢复</button> <span id="jsonRes" class="status-line"></span>`,
    onMount: (d) => {
      let cands = [];
      $('#chatParse', d).onclick = async () => {
        const file = $('#chatFile', d).files[0];
        let data = $('#chatText', d).value;
        if (file) data = await file.text();
        if (!data.trim()) return toast('请先选择文件或粘贴文本', { error: true });
        let payload = data;
        try { payload = JSON.parse(data); } catch { /* 纯文本 */ }
        try {
          const r = await post('/api/import/chat', { format: 'auto', data: payload });
          cands = r.candidates;
          $('#chatRes', d).innerHTML = cands.length
            ? `<p>${r.sessions} 段对话，挑出 ${cands.length} 条候选。勾选要入库的：</p>
               <div style="max-height:260px;overflow:auto;border:1px solid var(--c-line);border-radius:8px">${cands.map((c, i) => `<label style="display:flex;gap:12px;padding:8px 12px;border-bottom:1px solid var(--c-line)"><input type="checkbox" data-c="${i}" checked><span><strong>${esc(c.title || '(无标题)')}</strong><br><span style="color:var(--c-text-2);font-size:12px">${esc(String(c.text).slice(0, 120))}</span></span></label>`).join('')}</div>
               <button class="btn primary" type="button" id="chatCommit" style="margin-top:12px">导入选中项</button>`
            : `<p>解析了 ${r.sessions} 段对话，没有挑出像 prompt 的用户消息。</p>`;
          const commit = $('#chatCommit', d);
          if (commit) commit.onclick = async () => {
            const picked = $$('[data-c]', d).filter((x) => x.checked).map((x) => cands[Number(x.dataset.c)]);
            const r2 = await post('/api/import/chat/commit', { candidates: picked });
            toast(`已导入 ${r2.created.length} 条到收件箱`); closeDialog(); emit('refresh'); emit('go', { type: 'inbox' });
          };
        } catch (e) { toast(e.message, { error: true }); }
      };
      $('#obsGo', d).onclick = async () => {
        const r = $('#obsRes', d);
        try { const out = await post('/api/import/obsidian', { dir: $('#obsDir', d).value.trim() }); if (out.error) throw new Error(out.error); r.className = 'status-line ok'; r.textContent = `已导入 ${out.imported} 条`; emit('refresh'); }
        catch (e) { r.className = 'status-line bad'; r.textContent = e.message; }
      };
      $('#jsonGo', d).onclick = async () => {
        const f = $('#jsonFile', d).files[0], r = $('#jsonRes', d);
        if (!f) return toast('请先选择文件', { error: true });
        try { const out = await post('/api/import/json', JSON.parse(await f.text())); r.className = 'status-line ok'; r.textContent = `已恢复 ${out.imported} 条`; emit('refresh'); }
        catch (e) { r.className = 'status-line bad'; r.textContent = e.message; }
      };
    },
  });
}

export function openPending() {
  const render = () => state.pendingTags.length
    ? `<ul class="rows">${state.pendingTags.map((t) => `<li><span class="grow">#${esc(t.name)}（${t.count} 条）</span><button class="btn sm" data-ok="${t.id}" type="button">通过</button><button class="btn sm danger" data-no="${t.id}" type="button">删除</button></li>`).join('')}</ul>`
    : '<p>没有待审标签。</p>';
  openDialog({
    title: '待审标签', body: `<div id="pendBox">${render()}</div>`,
    onMount: (d) => {
      d.onclick = async (e) => {
        const ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]');
        if (!ok && !no) return;
        if (ok) await post(`/api/tags/${ok.dataset.ok}/approve`);
        else if (await confirmDialog('删除标签', '会同时从所有条目上移除这个标签。', '删除', true)) await post(`/api/tags/${no.dataset.no}/reject`);
        else return;
        emit('refresh'); closeDialog();
      };
    },
  });
}

export function openNewCollection() {
  openDialog({
    title: '新建集合', compact: true,
    body: `<div class="field"><label for="ncName">集合名称</label><input id="ncName" type="text" placeholder="如：写作提示词" autocomplete="off"></div>`,
    foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="ncOk">创建</button>`,
    onMount: (d) => {
      const input = $('#ncName', d);
      const ok = async () => {
        const name = input.value.trim();
        if (!name) return;
        const r = await post('/api/collections', { name });
        toast(`已创建集合「${name}」`);
        closeDialog(); emit('refresh');
        // 在集合总览里建的 → refresh 会重渲染网格；否则跳进新集合
        if (state.view.type !== 'collections') emit('go', { type: 'collection', id: r.id, name });
      };
      $('#ncOk', d).onclick = ok;
      input.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) ok(); };
      input.focus();
    },
  });
}

export function openKind() {
  const it = current();
  if (!it) return;
  openDialog({
    title: '改类型', compact: true,
    body: `<div class="field"><label for="kSel">类型</label><select id="kSel">${['prompt', 'skill', 'snippet', 'note', 'resource', 'unknown'].map((k) => `<option value="${k}" ${k === it.kind ? 'selected' : ''}>${{ prompt: 'prompt', skill: 'skill', snippet: '片段', note: '笔记', resource: '推荐资源', unknown: '未分类' }[k]}</option>`).join('')}</select></div>`,
    foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="kOk">保存</button>`,
    onMount: (d) => { $('#kOk', d).onclick = async () => { await patch(`/api/items/${it.id}`, { kind: $('#kSel', d).value }); closeDialog(); emit('refresh'); emit('select', it.id); }; },
  });
}

export async function openCollection() {
  const it = current();
  if (!it) return;
  const cols = await get('/api/collections');
  openDialog({
    title: '加入集合', compact: true,
    body: `<div class="field"><label for="cSel">已有集合</label><select id="cSel"><option value="">— 选择 —</option>${cols.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="cNew">或新建集合</label><input id="cNew" type="text" placeholder="集合名称"></div>`,
    foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="cOk">加入</button>`,
    onMount: (d) => {
      $('#cOk', d).onclick = async () => {
        let id = Number($('#cSel', d).value);
        const name = $('#cNew', d).value.trim();
        if (name) { const r = await post('/api/collections', { name }); id = Number(r.id); }
        if (!id) return toast('请选择或新建一个集合', { error: true });
        await post(`/api/collections/${id}/items`, { item_id: it.id, add: true });
        toast('已加入集合'); closeDialog(); emit('refresh'); emit('select', it.id);
      };
    },
  });
}
