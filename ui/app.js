const platforms = [{ id: 'kimi', label: 'Kimi' }, { id: 'yuanbao', label: '腾讯元宝' }, { id: 'deepseek', label: 'DeepSeek' }];
const content = document.querySelector('#content');
let pollTimer = null;

const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const splitAliases = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
const projectPayload = (form) => ({ name: form.name.value, brand_name: form.brand_name.value, brand_aliases: splitAliases(form.brand_aliases.value), competitors: form.competitors.value.split('\n').map((name) => name.trim()).filter(Boolean).map((name) => ({ name, aliases: [] })), selected_platforms: [...form.querySelectorAll('[data-platform].selected')].map((node) => node.dataset.platform) });
const platformNames = (ids) => ids.map((id) => platforms.find((platform) => platform.id === id)?.label || id).join('、');
const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
const setRoute = (route) => { location.hash = route; };
const openProjects = () => setRoute('#/projects');
const openProject = (id) => setRoute(`#/projects/${encodeURIComponent(id)}`);
const openBatch = (projectId, batchId) => setRoute(`#/projects/${encodeURIComponent(projectId)}/batches/${encodeURIComponent(batchId)}`);
const openBatchResult = (projectId, batchId) => setRoute(`#/projects/${encodeURIComponent(projectId)}/batches/${encodeURIComponent(batchId)}/result`);

function renderError(error) {
  stopPolling();
  content.innerHTML = `<div class="panel"><p class="notice">${escapeHtml(error.message)}</p><button type="button" class="secondary" onclick="location.reload()">重新加载</button></div>`;
}

async function showProjects() {
  stopPolling();
  try {
    const projects = await api('/api/projects');
    document.querySelector('h1').textContent = '监测项目';
    content.innerHTML = projects.length
      ? `<div class="grid">${projects.map((project) => `<article class="card" data-project="${project.project_id}"><h2>${escapeHtml(project.name)}</h2><p class="muted">品牌：${escapeHtml(project.brand_name)}</p><p>${project.competitors.length} 个竞品 · ${project.prompt_count} 个监测问题</p><p class="muted">${escapeHtml(platformNames(project.selected_platforms))}</p></article>`).join('')}</div>`
      : '<div class="empty"><h2>还没有监测项目</h2><p class="muted">创建一个项目，配置品牌、竞品、AI 平台和监测问题。</p><button type="button" id="empty-new">新建项目</button></div>';
    document.querySelectorAll('[data-project]').forEach((node) => { node.onclick = () => openProject(node.dataset.project); });
    document.querySelector('#empty-new')?.addEventListener('click', () => setRoute('#/new'));
  } catch (error) { renderError(error); }
}

function projectForm(project = {}) {
  const selected = project.selected_platforms || platforms.map((item) => item.id);
  return `<form id="project-form" class="stack"><div class="form-grid"><div class="field"><label>项目名称</label><input name="name" required value="${escapeHtml(project.name)}" placeholder="例如：电动汽车品牌监测"></div><div class="field"><label>品牌</label><input name="brand_name" required value="${escapeHtml(project.brand_name)}" placeholder="例如：比亚迪"></div><div class="field"><label>品牌别名（用逗号分隔）</label><input name="brand_aliases" value="${escapeHtml((project.brand_aliases || []).join(', '))}" placeholder="例如：BYD"></div><div class="field"><label>竞品（每行一个）</label><textarea name="competitors" placeholder="特斯拉\n吉利">${escapeHtml((project.competitors || []).map((item) => item.name).join('\n'))}</textarea></div><div class="field full"><label>AI 平台</label><div class="platforms">${platforms.map((item) => `<button type="button" class="platform ${selected.includes(item.id) ? 'selected' : ''}" data-platform="${item.id}">${escapeHtml(item.label)}</button>`).join('')}</div><span class="notice" id="platform-notice" aria-live="polite"></span></div></div><div class="actions"><button type="button" id="save-project">保存配置</button><span class="notice" id="project-notice" aria-live="polite"></span></div></form>`;
}

function bindProjectForm(projectId) {
  const form = document.querySelector('#project-form');
  const saveButton = document.querySelector('#save-project');
  const notice = document.querySelector('#project-notice');
  const platformNotice = document.querySelector('#platform-notice');
  document.querySelectorAll('[data-platform]').forEach((node) => {
    node.onclick = (event) => { event.preventDefault(); node.classList.toggle('selected'); platformNotice.textContent = ''; };
  });
  form.onsubmit = (event) => { event.preventDefault(); return false; };
  saveButton.onclick = async () => {
    const selected = form.querySelectorAll('[data-platform].selected');
    if (selected.length === 0) { platformNotice.textContent = '请至少选择一个 AI 平台'; return; }
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
    notice.textContent = '';
    platformNotice.textContent = '';
    try {
      const project = await api(projectId ? `/api/projects/${projectId}` : '/api/projects', { method: projectId ? 'PATCH' : 'POST', body: JSON.stringify(projectPayload(form)) });
      if (!projectId) openProject(project.project_id);
      else { saveButton.disabled = false; saveButton.textContent = '保存配置'; notice.textContent = '已保存'; }
    } catch (error) {
      notice.textContent = `保存失败：${error.message}`;
      saveButton.disabled = false;
      saveButton.textContent = '保存配置';
    }
  };
}

async function showCreate() {
  stopPolling();
  document.querySelector('h1').textContent = '新建监测项目';
  content.innerHTML = `<div class="panel">${projectForm({ selected_platforms: platforms.map((item) => item.id) })}</div>`;
  bindProjectForm();
}

function promptMarkup(prompt) {
  return `<div class="prompt"><div class="prompt-view" data-prompt-view="${prompt.prompt_id}"><div>${escapeHtml(prompt.text)}</div><button type="button" class="secondary" data-edit-prompt="${prompt.prompt_id}">编辑</button></div><form class="prompt-edit-form" data-prompt-edit="${prompt.prompt_id}" hidden><textarea name="text" required>${escapeHtml(prompt.text)}</textarea><div class="actions"><button type="submit">保存修改</button><button type="button" class="secondary" data-cancel-edit="${prompt.prompt_id}">取消</button></div></form></div>`;
}

function runConfirmation(preview) {
  return `<section class="run-confirmation"><h3>运行前确认</h3><p>当前监测问题：${preview.monitoring_question_count} 个</p><p>已选择平台：${escapeHtml(platformNames(preview.selected_platforms))}</p><p class="run-total">${preview.monitoring_question_count} 个监测问题 × ${preview.selected_platforms.length} 个 AI 平台 = ${preview.run_count} 次真实 AI Web Observation</p><div class="actions"><button type="button" class="secondary" id="cancel-run">取消</button><button type="button" id="confirm-run">确认运行</button><span class="notice" id="run-notice" aria-live="polite"></span></div></section>`;
}

function batchHistoryMarkup(history) {
  if (!history.length) return '<p class="muted">还没有历史监测。</p>';
  return `<div class="history-list">${history.map((batch) => `<div class="history-row"><div><strong>${escapeHtml(batch.status)}</strong><p class="muted">${escapeHtml(batch.created_at)} · ${batch.question_count} 个监测问题 · ${batch.platform_count} 个平台 · ${batch.completed_plan_count} / ${batch.plan_count} 已完成</p></div><button type="button" class="secondary" data-open-batch="${escapeHtml(batch.batch_id)}">查看结果</button></div>`).join('')}</div>`;
}

async function showProject(id, saveFeedback = '') {
  stopPolling();
  try {
    const view = await api(`/api/projects/${id}`);
    const history = await api(`/api/projects/${id}/batches`);
    document.querySelector('h1').textContent = view.project.name;
    const extraNotice = view.has_additional_prompt_sets ? '<p class="muted">已保留其他监测问题，当前先展示主要问题。</p>' : '';
    const promptsMarkup = view.monitoring_prompts.length ? view.monitoring_prompts.map(promptMarkup).join('') : '<p class="muted">还没有监测问题。</p>';
    content.innerHTML = `<div class="stack"><section class="panel"><div class="toolbar"><h2>监测配置</h2><button type="button" class="secondary" id="back">返回项目首页</button></div>${projectForm(view.project)}<div class="run-actions"><button type="button" id="run-batch">运行本次监测</button><span class="notice" id="run-entry-notice" aria-live="polite"></span><div id="run-confirmation"></div></div></section><section class="panel"><div class="toolbar"><h2>监测问题</h2></div>${extraNotice}<div id="prompt-list">${promptsMarkup}</div><form id="prompt-form"><input name="text" required placeholder="输入新的监测问题"><button type="submit">添加</button></form></section><section class="panel"><div class="toolbar"><h2>历史监测</h2></div>${batchHistoryMarkup(history)}</section></div>`;
    document.querySelector('#back').onclick = openProjects;
    document.querySelectorAll('[data-open-batch]').forEach((button) => { button.onclick = () => openBatchResult(id, button.dataset.openBatch); });
    bindProjectForm(id);
    if (saveFeedback) document.querySelector('#project-notice').textContent = saveFeedback;
    document.querySelector('#run-batch').onclick = async () => {
      const entryNotice = document.querySelector('#run-entry-notice');
      entryNotice.textContent = '';
      try {
        const preview = await api(`/api/projects/${id}/run-preview`);
        if (!preview.can_run) { entryNotice.textContent = preview.message; return; }
        document.querySelector('#run-confirmation').innerHTML = runConfirmation(preview);
        document.querySelector('#cancel-run').onclick = () => { document.querySelector('#run-confirmation').innerHTML = ''; };
        document.querySelector('#confirm-run').onclick = async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = '正在启动…';
          document.querySelector('#run-notice').textContent = '';
          try {
            const created = await api(`/api/projects/${id}/batches`, { method: 'POST', body: '{}' });
            openBatch(id, created.batch.batch_id);
          } catch (error) {
            button.disabled = false;
            button.textContent = '确认运行';
            document.querySelector('#run-notice').textContent = error.message;
          }
        };
      } catch (error) { entryNotice.textContent = error.message; }
    };
    document.querySelector('#prompt-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      await api(`/api/projects/${id}/prompts`, { method: 'POST', body: JSON.stringify({ text: form.text.value }) });
      showProject(id);
    };
    document.querySelectorAll('[data-edit-prompt]').forEach((button) => {
      button.onclick = () => { document.querySelector(`[data-prompt-view="${button.dataset.editPrompt}"]`).hidden = true; document.querySelector(`[data-prompt-edit="${button.dataset.editPrompt}"]`).hidden = false; };
    });
    document.querySelectorAll('[data-cancel-edit]').forEach((button) => {
      button.onclick = () => { document.querySelector(`[data-prompt-view="${button.dataset.cancelEdit}"]`).hidden = false; document.querySelector(`[data-prompt-edit="${button.dataset.cancelEdit}"]`).hidden = true; };
    });
    document.querySelectorAll('.prompt-edit-form').forEach((form) => {
      form.onsubmit = async (event) => { event.preventDefault(); await api(`/api/prompts/${form.dataset.promptEdit}`, { method: 'PATCH', body: JSON.stringify({ text: form.text.value }) }); showProject(id); };
    });
  } catch (error) { renderError(error); }
}

const planText = { pending: '等待中', running: '运行中', completed: '已完成', failed: '执行失败', skipped: '未执行', blocked: '需要处理', login_required: '需要登录', user_action_required: '需要处理' };
const batchText = { ready: '等待开始', running: '运行中', completed: '已完成', completed_with_failures: '已完成（含失败）', blocked: '需要处理' };
const terminalPlan = (plan) => ['completed', 'failed', 'skipped'].includes(plan.status);

function progressMarkup(projectId, batchId, data) {
  const { batch, plans } = data;
  const finished = plans.filter(terminalPlan).length;
  const running = plans.find((plan) => plan.status === 'running');
  const paused = plans.find((plan) => ['blocked', 'login_required', 'user_action_required'].includes(plan.status));
  const rows = platforms.map((platform) => {
    const platformPlans = plans.filter((plan) => plan.platform === platform.id);
    if (platformPlans.length === 0) return `<div class="progress-row"><span>${platform.label}</span><span>—</span><strong>未选择</strong></div>`;
    const done = platformPlans.filter(terminalPlan).length;
    const current = platformPlans.find((plan) => plan.status === 'running') || platformPlans.find((plan) => ['blocked', 'login_required', 'user_action_required'].includes(plan.status)) || platformPlans.find((plan) => plan.status === 'pending');
    return `<div class="progress-row"><span>${platform.label}</span><span>${done} / ${platformPlans.length}</span><strong>${current ? planText[current.status] : '已完成'}</strong></div>`;
  }).join('');
  const current = running || paused;
  const currentText = current ? `<p>当前正在监测：<strong>${escapeHtml(platformNames([current.platform]))}</strong></p><p class="muted">“${escapeHtml(current.prompt_text)}”</p>` : '<p class="muted">当前没有正在执行的监测问题。</p>';
  const pauseText = paused ? (paused.status === 'login_required'
    ? `<p class="notice">${escapeHtml(platformNames([paused.platform]))} 需要登录。请在打开的 ${escapeHtml(platformNames([paused.platform]))} 页面完成登录，处理完成后返回这里继续本次监测。</p>`
    : '<p class="notice">本次监测需要你先处理当前平台页面后才能继续。</p>') : '';
  const resume = paused ? '<button type="button" id="resume-batch">继续</button>' : '';
  const resultButton = ['completed', 'completed_with_failures'].includes(batch.status) ? '<button type="button" class="secondary" id="open-batch-result">查看原始结果</button>' : '';
  return `<section class="panel"><div class="toolbar"><h2>本次监测</h2><div class="actions">${resultButton}<button type="button" class="secondary" id="back-project">返回项目配置</button></div></div><p class="batch-status">总体状态：<strong>${batchText[batch.status] || '处理中'}</strong></p><p class="run-total">${finished} / ${plans.length} 已完成</p><div class="progress-list">${rows}</div><div class="current-run">${currentText}${pauseText}<div class="actions">${resume}<span class="notice" id="batch-notice" aria-live="polite"></span></div></div></section>`;
}

async function showBatch(projectId, batchId) {
  stopPolling();
  document.querySelector('h1').textContent = '本次监测';
  content.innerHTML = '<div class="panel"><p class="muted">正在读取本次监测进度…</p></div>';
  const refresh = async () => {
    try {
      const data = await api(`/api/batches/${batchId}`);
      content.innerHTML = progressMarkup(projectId, batchId, data);
      document.querySelector('#back-project').onclick = () => openProject(projectId);
      document.querySelector('#open-batch-result')?.addEventListener('click', () => openBatchResult(projectId, batchId));
      document.querySelector('#resume-batch')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '继续中…';
        try { await api(`/api/batches/${batchId}/resume`, { method: 'POST', body: '{}' }); await refresh(); }
        catch (error) { document.querySelector('#batch-notice').textContent = error.message; button.disabled = false; button.textContent = '继续'; }
      });
      return ['completed', 'completed_with_failures'].includes(data.batch.status);
    } catch (error) { renderError(error); }
  };
  const terminal = await refresh();
  if (!terminal) pollTimer = setInterval(refresh, 1200);
}

function citationDisplayDomain(citation) {
  if (citation.display_domain) return citation.display_domain;
  if (citation.link_url) {
    try { return new URL(citation.link_url).hostname; }
    catch { return '未知来源'; }
  }
  return '未知来源';
}

function citationMarkup(citation) {
  const position = citation.position ?? '—';
  const domain = citationDisplayDomain(citation);
  const title = citation.title?.trim() || null;
  const label = title ? `来源 ${position} · ${title}` : `来源 ${position} · ${domain}`;
  const metadata = title && domain ? `${domain} · ${citation.association_method}` : citation.association_method;
  const sourceLink = citation.link_url ? `<a class="citation-source" target="_blank" rel="noopener" href="${escapeHtml(citation.link_url)}">打开来源</a>` : '';
  return `<li><div>${escapeHtml(label)}</div><div class="muted">${escapeHtml(metadata)}</div>${sourceLink}</li>`;
}

function rawRunMarkup(entry) {
  const answer = entry.answer ? `<h4>完整 Answer</h4><pre class="raw-answer answer-preview">${escapeHtml(entry.answer.text)}</pre><button type="button" class="secondary answer-toggle" data-answer-toggle aria-expanded="false">展开完整回答</button>` : '<p class="muted">没有已捕获的 Answer。</p>';
  const citations = entry.citations.length
    ? `<ol class="citation-list">${entry.citations.map(citationMarkup).join('')}</ol>`
    : '<p class="muted">Formal Citation：0</p>';
  const sourcePool = entry.source_pool ? `<p class="source-pool">平台报告的 source pool：${entry.source_pool.reported_count}（不等同于 Formal Citation）</p>` : '';
  const evidence = entry.evidence.length
    ? `<ul class="evidence-list">${entry.evidence.map((artifact) => `<li>${escapeHtml(artifact.kind)} · <code>${escapeHtml(artifact.artifact_id)}</code> · <a target="_blank" rel="noopener" href="/api/artifacts/${encodeURIComponent(artifact.artifact_id)}/content">查看本地证据</a></li>`).join('')}</ul>`
    : '<p class="muted">没有已记录的 Evidence metadata。</p>';
  const error = entry.terminal.error ? `<p class="notice">${escapeHtml(entry.terminal.error)}</p>` : '';
  return `<article class="raw-run"><div class="toolbar"><h3>${escapeHtml(platformNames([entry.platform_snapshot]))}</h3><strong>${escapeHtml(planText[entry.status] || entry.status)}</strong></div><p class="muted">Plan：${escapeHtml(entry.plan_id)} · Run：${escapeHtml(entry.run_id || '—')}</p>${error}${answer}<h4>Formal Citations（${entry.citations.length}）</h4>${citations}${sourcePool}<h4>Evidence</h4>${evidence}</article>`;
}

function resultMarkup(projectId, result) {
  const questions = result.question_snapshots.map((question) => {
    const entries = result.runs.filter((entry) => entry.question_snapshot.prompt_id === question.prompt_id);
    return `<section class="panel"><h2>监测问题</h2><p>${escapeHtml(question.text)}</p>${entries.map(rawRunMarkup).join('')}</section>`;
  }).join('');
  return `<div class="stack batch-result"><section class="panel"><div class="toolbar"><div><h2>原始监测结果</h2><p class="muted">Batch：${escapeHtml(result.batch.batch_id)} · ${escapeHtml(result.batch.status)} · ${escapeHtml(result.schema_version)}</p></div><div class="actions"><a class="button-link secondary" href="/api/batches/${encodeURIComponent(result.batch.batch_id)}/export" download>导出 JSON</a><button type="button" class="secondary" id="back-batch-result">返回项目</button></div></div><p class="muted">以下内容是原始 Observation facts；不包含 GEO Score、情感或其他推导分析。</p></section>${questions}</div>`;
}

async function showBatchResult(projectId, batchId) {
  stopPolling();
  document.querySelector('h1').textContent = '原始监测结果';
  content.innerHTML = '<div class="panel"><p class="muted">正在读取原始监测结果…</p></div>';
  try {
    const result = await api(`/api/batches/${batchId}/result`);
    content.innerHTML = resultMarkup(projectId, result);
    document.querySelector('#back-batch-result').onclick = () => openProject(projectId);
    document.querySelectorAll('[data-answer-toggle]').forEach((button) => {
      button.onclick = () => {
        const answer = button.previousElementSibling;
        const expanded = answer.classList.toggle('answer-preview');
        button.textContent = expanded ? '展开完整回答' : '收起回答';
        button.setAttribute('aria-expanded', String(!expanded));
      };
    });
  } catch (error) { renderError(error); }
}

function route() {
  const value = location.hash || '#/projects';
  const result = value.match(/^#\/projects\/([^/]+)\/batches\/([^/]+)\/result$/);
  if (result) return showBatchResult(decodeURIComponent(result[1]), decodeURIComponent(result[2]));
  const batch = value.match(/^#\/projects\/([^/]+)\/batches\/([^/]+)$/);
  if (batch) return showBatch(decodeURIComponent(batch[1]), decodeURIComponent(batch[2]));
  const project = value.match(/^#\/projects\/([^/]+)$/);
  if (project) return showProject(decodeURIComponent(project[1]));
  if (value === '#/new') return showCreate();
  return showProjects();
}

document.querySelector('#new-project').onclick = () => setRoute('#/new');
window.addEventListener('hashchange', route);
route();
