import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MonitoringApplication } from '../src/application/monitoring-application.js';
import { openDatabase, GeoRepository } from '../src/db/repository.js';
import { createProductUiApplication, createProductUiServer, PRODUCT_UI_RUNTIME_PROFILES_ROOT } from '../src/ui/product-ui-server.js';

async function fixture({ executorFactory } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-ui-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  let runNumber = 0;
  const defaultExecutor = {
    async execute(plan) {
      const runId = `ui-run-${runNumber++}`;
      repository.createRun({ run_id: runId, prompt_id: plan.prompt_id, prompt_text: plan.prompt_text, platform: plan.platform,
        started_at: '2026-09-08T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'ui-test' });
      return { status: 'completed', run_id: runId };
    }
  };
  const app = new MonitoringApplication({ repository, planExecutor: executorFactory?.({ repository }) ?? defaultExecutor });
  const server = createProductUiServer({ app, staticRoot: join(process.cwd(), 'ui') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const request = async (path, options) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'content-type': 'application/json' }, ...options });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => { await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); };
  return { request, app, close };
}

const waitFor = async (predicate, timeoutMs = 500) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for expected Batch state.');
};

test('Product UI composition keeps profiles in the repository while validation data and artifacts use its cwd', () => {
  const validationDirectory = mkdtempSync(join(tmpdir(), 'ai-geo-validation-cwd-'));
  const originalCwd = process.cwd();
  let db;
  try {
    process.chdir(validationDirectory);
    db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
    const app = createProductUiApplication({ repository: new GeoRepository(db) });
    const factory = app.planExecutor.runtimeFactory;
    assert.equal(factory.profilesRoot, PRODUCT_UI_RUNTIME_PROFILES_ROOT);
    assert.equal(factory.artifactStore.rootDir, resolve(validationDirectory, 'artifacts'));
    assert.equal(factory.artifactStore.projectDir, validationDirectory);
    for (const platform of ['kimi', 'yuanbao', 'deepseek']) {
      const runtime = factory.create(platform);
      assert.equal(runtime.session.runtime.profileDir, resolve(PRODUCT_UI_RUNTIME_PROFILES_ROOT, platform));
    }
    assert.equal(resolve('data', 'geo-monitor.sqlite'), join(validationDirectory, 'data', 'geo-monitor.sqlite'));
  } finally {
    db?.close();
    process.chdir(originalCwd);
    rmSync(validationDirectory, { recursive: true, force: true });
  }
});

test('Product UI transport uses MonitoringApplication for project and prompt persistence', async () => {
  const context = await fixture();
  try {
    assert.deepEqual((await context.request('/api/projects')).body, []);
    const created = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '汽车监测', brand_name: '品牌A', brand_aliases: ['A'], competitors: [{ name: '竞品B', aliases: [] }], selected_platforms: ['kimi', 'yuanbao', 'deepseek'] }) });
    assert.equal(created.status, 201);
    const projectId = created.body.project_id;
    const updated = await context.request(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: '汽车监测', brand_name: '新品牌', brand_aliases: ['NB'], competitors: [{ name: '竞品C', aliases: [] }], selected_platforms: ['kimi', 'deepseek'] }) });
    assert.deepEqual(updated.body.selected_platforms, ['kimi', 'deepseek']);
    const set = await context.request(`/api/projects/${projectId}/prompt-sets`, { method: 'POST', body: JSON.stringify({ name: '自然问题' }) });
    const prompt = await context.request(`/api/prompt-sets/${set.body.prompt_set_id}/prompts`, { method: 'POST', body: JSON.stringify({ text: '应该重点看哪些参数？' }) });
    const edited = await context.request(`/api/prompts/${prompt.body.prompt_id}`, { method: 'PATCH', body: JSON.stringify({ text: '第一次购买应该重点看哪些参数？' }) });
    assert.equal(edited.body.text, '第一次购买应该重点看哪些参数？');
    const reloaded = await context.request(`/api/projects/${projectId}`);
    assert.equal(reloaded.body.project.brand_name, '新品牌');
    assert.equal(reloaded.body.monitoring_prompts[0].text, '第一次购买应该重点看哪些参数？');
  } finally { await context.close(); }
});

test('Product UI transport rejects unsupported platforms before persistence', async () => {
  const context = await fixture();
  try {
    const result = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '非法', brand_name: '品牌', selected_platforms: ['openai'] }) });
    assert.equal(result.status, 400);
    assert.deepEqual((await context.request('/api/projects')).body, []);
  } finally { await context.close(); }
});

test('Product UI adds the first monitoring question through an automatic default Prompt Set', async () => {
  const context = await fixture();
  try {
    const created = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '问题项目', brand_name: '品牌', selected_platforms: ['kimi'] }) });
    const prompt = await context.request(`/api/projects/${created.body.project_id}/prompts`, { method: 'POST', body: JSON.stringify({ text: '第一个监测问题' }) });
    assert.equal(prompt.status, 201);
    const view = await context.request(`/api/projects/${created.body.project_id}`);
    assert.equal(view.body.monitoring_prompts[0].text, '第一个监测问题');
    assert.equal(view.body.has_additional_prompt_sets, false);
  } finally { await context.close(); }
});

test('Product UI previews before confirmation, starts one background Batch, and reads persisted progress', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = await fixture({ executorFactory: ({ repository }) => {
    let runNumber = 0;
    return {
      async execute(plan) {
        await gate;
        const runId = `slow-run-${runNumber++}`;
        repository.createRun({ run_id: runId, prompt_id: plan.prompt_id, prompt_text: plan.prompt_text, platform: plan.platform,
          started_at: '2026-09-08T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'ui-test' });
        return { status: 'completed', run_id: runId };
      }
    };
  } });
  try {
    const project = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Batch 项目', brand_name: '品牌', selected_platforms: ['kimi', 'yuanbao', 'deepseek'] }) });
    const projectId = project.body.project_id;
    assert.deepEqual((await context.request(`/api/projects/${projectId}/run-preview`)).body, { can_run: false, message: '请先添加至少一个监测问题。' });
    assert.equal(context.app.listPromptSets(projectId).length, 0);

    await context.request(`/api/projects/${projectId}/prompts`, { method: 'POST', body: JSON.stringify({ text: '要监测什么？' }) });
    const preview = await context.request(`/api/projects/${projectId}/run-preview`);
    assert.equal(preview.body.monitoring_question_count, 1);
    assert.deepEqual(preview.body.selected_platforms, ['kimi', 'yuanbao', 'deepseek']);
    assert.equal(preview.body.run_count, 3);

    const startedAt = Date.now();
    const created = await context.request(`/api/projects/${projectId}/batches`, { method: 'POST', body: '{}' });
    assert.equal(created.status, 202);
    assert.ok(Date.now() - startedAt < 200, 'start response must not wait for the executor');
    const batchId = created.body.batch.batch_id;
    assert.equal(context.app.getBatch(batchId).snapshot.prompts[0].text, '要监测什么？');
    assert.deepEqual(context.app.getBatch(batchId).snapshot.selected_platforms, ['kimi', 'yuanbao', 'deepseek']);
    assert.equal((await context.request(`/api/projects/${projectId}/batches`, { method: 'POST', body: '{}' })).status, 409);

    const running = await waitFor(async () => {
      const progress = await context.request(`/api/batches/${batchId}`);
      return progress.body.plans.some((plan) => plan.status === 'running') && progress;
    });
    assert.equal(running.status, 200);
    assert.equal(running.body.plans.length, 3);
    release();
    const completed = await waitFor(async () => {
      const progress = await context.request(`/api/batches/${batchId}`);
      return progress.body.batch.status === 'completed' && progress;
    });
    assert.ok(completed.body.plans.every((plan) => plan.status === 'completed'));
  } finally { await context.close(); }
});

test('Product UI exposes blocked progress and resumes through MonitoringApplication', async () => {
  const context = await fixture({ executorFactory: ({ repository }) => {
    let calls = 0;
    return {
      async execute(plan) {
        if (calls++ === 0) return { status: 'login_required', error: 'manual login' };
        const runId = `resume-run-${calls}`;
        repository.createRun({ run_id: runId, prompt_id: plan.prompt_id, prompt_text: plan.prompt_text, platform: plan.platform,
          started_at: '2026-09-08T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'ui-test' });
        return { status: 'completed', run_id: runId };
      }
    };
  } });
  try {
    const project = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '继续项目', brand_name: '品牌', selected_platforms: ['kimi'] }) });
    await context.request(`/api/projects/${project.body.project_id}/prompts`, { method: 'POST', body: JSON.stringify({ text: '问题' }) });
    const created = await context.request(`/api/projects/${project.body.project_id}/batches`, { method: 'POST', body: '{}' });
    const batchId = created.body.batch.batch_id;
    const blocked = await waitFor(async () => {
      const progress = await context.request(`/api/batches/${batchId}`);
      return progress.body.batch.status === 'blocked' && progress;
    });
    assert.equal(blocked.body.plans[0].status, 'login_required');
    assert.equal((await context.request(`/api/batches/${batchId}/resume`, { method: 'POST', body: '{}' })).status, 202);
    const completed = await waitFor(async () => {
      const progress = await context.request(`/api/batches/${batchId}`);
      return progress.body.batch.status === 'completed' && progress;
    });
    assert.equal(completed.body.plans[0].status, 'completed');
  } finally { await context.close(); }
});

test('Batch Result View keeps historical snapshots and raw evidence complete through local JSON export', async () => {
  const context = await fixture();
  try {
    const project = await context.request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '历史项目', brand_name: '历史品牌', selected_platforms: ['kimi', 'yuanbao', 'deepseek'] }) });
    const projectId = project.body.project_id;
    const prompt = await context.request(`/api/projects/${projectId}/prompts`, { method: 'POST', body: JSON.stringify({ text: '历史监测问题' }) });
    const promptSet = context.app.listPromptSets(projectId)[0];
    const created = context.app.createBatch({ projectId, promptSetId: promptSet.prompt_set_id, batchId: 'batch-result-contract' });
    const [kimiPlan, yuanbaoPlan, deepseekPlan] = created.plans;
    const repository = context.app.repository;

    repository.transitionBatchRunPlan(kimiPlan.plan_id, 'running', { at: '2026-09-08T01:00:00.000Z' });
    repository.aggregateObservationBatch(created.batch.batch_id, { at: '2026-09-08T01:00:00.000Z' });
    repository.createRun({ run_id: 'result-kimi', prompt_id: kimiPlan.prompt_id, prompt_text: kimiPlan.prompt_text, platform: 'kimi', started_at: '2026-09-08T01:00:00.000Z', finished_at: '2026-09-08T01:01:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'captured', parser_version: 'result-test' });
    repository.saveAnswer({ run_id: 'result-kimi', answer_text: '未经改写的 Kimi Final Answer', answer_html_fragment: '<p>Answer</p>', response_fingerprint: 'fingerprint', brand_hits: [], competitor_hits: [] });
    repository.saveCitation({ citation_id: 'citation-2', run_id: 'result-kimi', position: 2, title: '第二条', link_url: 'https://two.example', display_domain: 'two.example', association_method: 'contained' });
    repository.saveCitation({ citation_id: 'citation-1', run_id: 'result-kimi', position: 1, title: '第一条', link_url: 'https://one.example', display_domain: 'one.example', association_method: 'trigger_bound' });
    repository.saveArtifact({ artifact_id: 'artifact-kimi-answer', run_id: 'result-kimi', kind: 'answer_html', path: 'artifacts/result-kimi/answer.html', created_at: '2026-09-08T01:01:00.000Z' });
    repository.attachRunToBatchRunPlan(kimiPlan.plan_id, 'result-kimi');
    repository.transitionBatchRunPlan(kimiPlan.plan_id, 'completed', { at: '2026-09-08T01:01:00.000Z' });

    repository.transitionBatchRunPlan(yuanbaoPlan.plan_id, 'running', { at: '2026-09-08T01:01:01.000Z' });
    repository.createRun({ run_id: 'result-yuanbao', prompt_id: yuanbaoPlan.prompt_id, prompt_text: yuanbaoPlan.prompt_text, platform: 'yuanbao', started_at: '2026-09-08T01:01:01.000Z', finished_at: '2026-09-08T01:02:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'result-test', platform_reported_source_count: 41 });
    repository.saveAnswer({ run_id: 'result-yuanbao', answer_text: '未经改写的 元宝 Final Answer', answer_html_fragment: '<p>Answer</p>', response_fingerprint: 'fingerprint-yb', brand_hits: [], competitor_hits: [] });
    repository.attachRunToBatchRunPlan(yuanbaoPlan.plan_id, 'result-yuanbao');
    repository.transitionBatchRunPlan(yuanbaoPlan.plan_id, 'completed', { at: '2026-09-08T01:02:00.000Z' });

    repository.transitionBatchRunPlan(deepseekPlan.plan_id, 'running', { at: '2026-09-08T01:02:01.000Z' });
    repository.transitionBatchRunPlan(deepseekPlan.plan_id, 'failed', { error: 'fresh-chat failed', at: '2026-09-08T01:02:02.000Z' });
    repository.aggregateObservationBatch(created.batch.batch_id, { at: '2026-09-08T01:02:02.000Z' });

    await context.request(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: '当前项目名称', brand_name: '当前品牌', selected_platforms: ['kimi'] }) });
    await context.request(`/api/prompts/${prompt.body.prompt_id}`, { method: 'PATCH', body: JSON.stringify({ text: '当前监测问题' }) });

    const result = await context.request(`/api/batches/${created.batch.batch_id}/result`);
    assert.equal(result.status, 200);
    assert.equal(result.body.schema_version, 'observation-batch-result/v1');
    assert.equal(result.body.project_snapshot.name, '历史项目');
    assert.equal(result.body.question_snapshots[0].text, '历史监测问题');
    assert.deepEqual(result.body.platform_snapshots, ['kimi', 'yuanbao', 'deepseek']);
    assert.equal(result.body.runs.length, 3);
    assert.equal(result.body.runs[0].answer.text, '未经改写的 Kimi Final Answer');
    assert.deepEqual(result.body.runs[0].citations.map((citation) => citation.citation_id), ['citation-1', 'citation-2']);
    assert.equal(result.body.runs[0].citations[0].association_method, 'trigger_bound');
    assert.equal(result.body.runs[0].evidence[0].run_id, 'result-kimi');
    assert.equal(result.body.runs[1].citations.length, 0);
    assert.deepEqual(result.body.runs[1].source_pool, { reported_count: 41 });
    assert.equal(result.body.runs[2].run_id, null);
    assert.equal(result.body.runs[2].answer, null);
    assert.deepEqual(result.body.runs[2].citations, []);
    assert.equal(result.body.runs[2].terminal.error, 'fresh-chat failed');
    assert.deepEqual(result.body, (await context.request(`/api/batches/${created.batch.batch_id}/result`)).body);

    const exported = await context.request(`/api/batches/${created.batch.batch_id}/export`);
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.body, result.body);
    const history = await context.request(`/api/projects/${projectId}/batches`);
    assert.equal(history.body[0].batch_id, created.batch.batch_id);
    assert.equal(history.body[0].completed_plan_count, 2);
  } finally { await context.close(); }
});

test('Product UI configuration interactions require explicit save and preserve platform labels', () => {
  const source = readFileSync(join(process.cwd(), 'ui', 'app.js'), 'utf8');
  const styles = readFileSync(join(process.cwd(), 'ui', 'styles.css'), 'utf8');
  assert.match(source, /form\.onsubmit = \(event\) => \{ event\.preventDefault\(\); return false; \}/);
  assert.match(source, /id="save-project"/);
  assert.match(source, /type="button" class="platform/);
  assert.match(source, /escapeHtml\(item\.label\)/);
  assert.match(source, /请至少选择一个 AI 平台/);
  assert.match(source, /保存中…/);
  assert.match(source, /已保存/);
  assert.match(source, /保存失败：/);
  assert.match(source, /notice\.textContent = '已保存'/);
  assert.match(source, /openProject\(project\.project_id\)/);
  assert.match(styles, /\.platform\{[^}]*color:#172033/);
  assert.doesNotMatch(source, /id="add-prompt"/);
  assert.match(source, /data-edit-prompt/);
  assert.match(source, /返回项目首页/);
  assert.doesNotMatch(source, /新建问题集/);
  assert.match(source, /\/api\/projects\/\$\{id\}\/prompts/);
  assert.match(styles, /#prompt-form button\{justify-self:start\}/);
  assert.match(source, /运行本次监测/);
  assert.match(source, /运行前确认/);
  assert.match(source, /确认运行/);
  assert.match(source, /本次监测/);
  assert.match(source, /登录。请在打开的/);
  assert.match(source, /\/api\/batches\/\$\{batchId\}/);
  assert.match(source, /历史监测/);
  assert.match(source, /原始监测结果/);
  assert.match(source, /Formal Citations/);
  assert.match(source, /不等同于 Formal Citation/);
  assert.match(source, /\/api\/batches\/\$\{batchId\}\/result/);
  assert.match(source, /\/api\/batches\/\$\{encodeURIComponent\(result\.batch\.batch_id\)\}\/export/);
  assert.doesNotMatch(source, /GeoRepository|Playwright|RunService|PlatformAdapter/);
});
