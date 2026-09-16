import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitoringApplication, OBSERVATION_BATCH_RESULT_SCHEMA_VERSION } from '../src/application/monitoring-application.js';
import { openDatabase, GeoRepository } from '../src/db/repository.js';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'observation-batch-result-v1.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function createContractContext() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-observation-contract-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const application = new MonitoringApplication({ repository, parserVersion: 'contract-test', runtimeVersion: 'contract-test' });
  const project = application.createProject({
    project_id: 'project-contract', name: '历史项目', brand_name: '历史品牌', brand_aliases: ['历史别名'],
    competitors: [{ name: '历史竞品', aliases: ['竞品别名'] }], selected_platforms: ['kimi', 'yuanbao']
  });
  const promptSet = application.createPromptSet({ prompt_set_id: 'set-contract', project_id: project.project_id, name: '问题集' });
  const prompt = application.addPrompt({ prompt_set_id: promptSet.prompt_set_id, prompt_id: 'prompt-contract', label: null, text: '历史问题', position: 0, enabled: true });
  const created = application.createBatch({ projectId: project.project_id, promptSetId: promptSet.prompt_set_id, batchId: 'batch-contract' });
  return { directory, db, repository, application, project, prompt, created };
}

function close(context) {
  context.db.close();
  rmSync(context.directory, { recursive: true, force: true });
}

function completeFirstPlan(context) {
  const [completedPlan, failedPlan] = context.created.plans;
  const { repository } = context;
  repository.transitionBatchRunPlan(completedPlan.plan_id, 'running', { at: '2026-09-08T02:00:00.000Z' });
  repository.aggregateObservationBatch(context.created.batch.batch_id, { at: '2026-09-08T02:00:00.000Z' });
  repository.createRun({
    run_id: 'run-contract', prompt_id: completedPlan.prompt_id, prompt_text: completedPlan.prompt_text,
    platform: 'kimi', started_at: '2026-09-08T02:00:00.000Z', finished_at: '2026-09-08T02:01:00.000Z',
    status: 'completed', answer_status: 'captured', citation_status: 'captured', parser_version: 'contract-test',
    platform_reported_source_count: 3
  });
  repository.saveAnswer({
    run_id: 'run-contract', answer_text: '原文 Final Answer，不应被改写。', answer_html_fragment: '<p>raw</p>',
    response_fingerprint: 'fingerprint-contract', brand_hits: [], competitor_hits: []
  });
  repository.saveCitation({
    citation_id: 'citation-contract', run_id: 'run-contract', position: 1, title: null,
    link_url: null, display_domain: null, association_method: 'contained'
  });
  repository.saveArtifact({
    artifact_id: 'artifact-contract-terminal', run_id: 'run-contract', kind: 'terminal_context_screenshot',
    path: 'artifacts/run-contract/terminal-context.png', created_at: '2026-09-08T02:01:00.000Z'
  });
  repository.attachRunToBatchRunPlan(completedPlan.plan_id, 'run-contract');
  repository.transitionBatchRunPlan(completedPlan.plan_id, 'completed', { at: '2026-09-08T02:01:00.000Z' });
  repository.transitionBatchRunPlan(failedPlan.plan_id, 'running', { at: '2026-09-08T02:01:01.000Z' });
  repository.transitionBatchRunPlan(failedPlan.plan_id, 'failed', { error: 'controlled failure', at: '2026-09-08T02:02:00.000Z' });
  repository.aggregateObservationBatch(context.created.batch.batch_id, { at: '2026-09-08T02:02:00.000Z' });
}

test('fixture freezes the v1 shape and contains only observation facts', () => {
  assert.equal(fixture.schema_version, OBSERVATION_BATCH_RESULT_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(fixture), ['schema_version', 'batch', 'project_snapshot', 'question_snapshots', 'platform_snapshots', 'runs']);
  assert.equal(fixture.runs[0].answer.text, '这是未经改写的脱敏 Final Answer。');
  assert.equal(fixture.runs[0].citations[0].link_url, null);
  assert.deepEqual(fixture.runs[0].source_pool, { reported_count: 3 });
  assert.equal(fixture.runs[0].evidence[0].kind, 'terminal_context_screenshot');
  assert.equal(fixture.runs[1].run_id, null);
  assert.equal(fixture.runs[1].answer, null);
  assert.deepEqual(fixture.runs[1].citations, []);
  assert.ok(!('score' in fixture) && !('sentiment' in fixture) && !('trend' in fixture));
});

test('v1 result preserves snapshots, semantic records, nulls, and deterministic export', () => {
  const context = createContractContext();
  try {
    completeFirstPlan(context);
    context.application.updateProject(context.project.project_id, { name: '当前项目', brand_name: '当前品牌', selected_platforms: ['yuanbao'] });
    context.application.updatePrompt(context.prompt.prompt_id, { text: '当前问题' });

    const result = context.application.getBatchResult(context.created.batch.batch_id);
    assert.equal(result.schema_version, OBSERVATION_BATCH_RESULT_SCHEMA_VERSION);
    assert.equal(result.batch.status, 'completed_with_failures');
    assert.deepEqual(result.project_snapshot, {
      id: 'project-contract', name: '历史项目', brand: { name: '历史品牌', aliases: ['历史别名'] },
      competitors: [{ name: '历史竞品', aliases: ['竞品别名'] }]
    });
    assert.deepEqual(result.question_snapshots, [{ prompt_id: 'prompt-contract', label: null, text: '历史问题', position: 0 }]);
    assert.deepEqual(result.platform_snapshots, ['kimi', 'yuanbao']);
    assert.equal(result.runs.length, 2);

    const completed = result.runs[0];
    assert.equal(completed.run_id, 'run-contract');
    assert.equal(completed.answer.text, '原文 Final Answer，不应被改写。');
    assert.equal(completed.answer.status, 'captured');
    assert.equal(completed.citations.length, 1);
    assert.equal(completed.citations[0].link_url, null);
    assert.equal(completed.citations[0].association_method, 'contained');
    assert.deepEqual(completed.source_pool, { reported_count: 3 });
    assert.equal(completed.evidence[0].run_id, 'run-contract');
    assert.equal(completed.evidence[0].kind, 'terminal_context_screenshot');

    const failed = result.runs[1];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.run_id, null);
    assert.equal(failed.run, null);
    assert.equal(failed.answer, null);
    assert.deepEqual(failed.citations, []);
    assert.equal(failed.source_pool, null);
    assert.equal(failed.terminal.error, 'controlled failure');

    const firstExport = context.application.exportBatchResult(context.created.batch.batch_id);
    const secondExport = context.application.exportBatchResult(context.created.batch.batch_id);
    assert.equal(firstExport, secondExport);
    assert.deepEqual(JSON.parse(firstExport), result);
    assert.equal(firstExport.charCodeAt(0), '{'.charCodeAt(0));
    assert.ok(!firstExport.includes('score') && !firstExport.includes('sentiment') && !firstExport.includes('recommendation'));
  } finally { close(context); }
});
