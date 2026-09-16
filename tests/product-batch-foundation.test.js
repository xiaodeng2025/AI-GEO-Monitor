import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, GeoRepository } from '../src/db/repository.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-product-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repo = new GeoRepository(db);
  repo.createMonitorProject({
    project_id: 'project-1', name: 'EV monitor', brand_name: '品牌A', brand_aliases: ['A'],
    competitors: [{ name: '竞品B', aliases: ['B'] }], selected_platforms: ['kimi', 'yuanbao', 'deepseek'],
    created_at: '2026-09-04T00:00:00.000Z'
  });
  repo.createPromptSet({ prompt_set_id: 'set-1', project_id: 'project-1', name: '自然问题', created_at: '2026-09-04T00:00:00.000Z' });
  repo.createPrompt({ prompt_id: 'prompt-2', prompt_set_id: 'set-1', label: '第二题', text: '第二个自然问题', position: 20, enabled: true, created_at: '2026-09-04T00:00:00.000Z' });
  repo.createPrompt({ prompt_id: 'prompt-1', prompt_set_id: 'set-1', label: null, text: '第一个自然问题', position: 10, enabled: true, created_at: '2026-09-04T00:00:00.000Z' });
  return { directory, db, repo };
}

function snapshot(repo) {
  const project = repo.getMonitorProject('project-1');
  const prompts = repo.listPrompts('set-1', { enabledOnly: true }).map((prompt) => ({
    id: prompt.prompt_id, label: prompt.label, text: prompt.text, order: prompt.position
  }));
  return {
    project: { id: project.project_id, name: project.name, brand: { name: project.brand_name, aliases: project.brand_aliases }, competitors: project.competitors },
    selected_platforms: project.selected_platforms,
    prompt_set: { id: 'set-1' }, prompts,
    runtime: { parser_version: 'product-batch-v1', runtime: 'playwright-web' },
    created_at: '2026-09-04T01:00:00.000Z'
  };
}

function createBatch(repo, id = 'batch-1') {
  return repo.createObservationBatch({
    batch_id: id, project_id: 'project-1', prompt_set_id: 'set-1', snapshot: snapshot(repo),
    created_at: '2026-09-04T01:00:00.000Z'
  });
}

function close({ directory, db }) { db.close(); rmSync(directory, { recursive: true, force: true }); }

test('ObservationBatch snapshots project and prompts, then creates stable cross-platform plans', () => {
  const context = fixture();
  try {
    const batch = createBatch(context.repo);
    assert.equal(batch.status, 'ready');
    assert.deepEqual(batch.snapshot.project.brand, { name: '品牌A', aliases: ['A'] });
    assert.equal(batch.snapshot.prompts[0].id, 'prompt-1');

    context.repo.updateMonitorProject('project-1', { brand_name: '新品牌', competitors: [], selected_platforms: ['kimi'] });
    context.repo.updatePrompt('prompt-1', { text: '已修改的问题' });
    const persisted = context.repo.getObservationBatch('batch-1');
    assert.equal(persisted.snapshot.project.brand.name, '品牌A');
    assert.deepEqual(persisted.snapshot.project.competitors, [{ name: '竞品B', aliases: ['B'] }]);
    assert.equal(persisted.snapshot.prompts[0].text, '第一个自然问题');
    assert.deepEqual(persisted.snapshot.selected_platforms, ['kimi', 'yuanbao', 'deepseek']);

    const plans = context.repo.generateBatchRunPlans('batch-1', { created_at: '2026-09-04T01:01:00.000Z' });
    assert.equal(plans.length, 6);
    assert.deepEqual(plans.map(({ prompt_id, platform, plan_position }) => [prompt_id, platform, plan_position]), [
      ['prompt-1', 'kimi', 0], ['prompt-1', 'yuanbao', 1], ['prompt-1', 'deepseek', 2],
      ['prompt-2', 'kimi', 3], ['prompt-2', 'yuanbao', 4], ['prompt-2', 'deepseek', 5]
    ]);
    assert.throws(() => context.repo.generateBatchRunPlans('batch-1'), /already exist/);
  } finally { close(context); }
});

test('BatchRunPlan may exist before a Run and attaches an existing Core Run once', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const [plan] = context.repo.generateBatchRunPlans('batch-1');
    assert.equal(plan.run_id, null);
    context.repo.createRun({ run_id: 'run-existing', prompt_id: 'prompt-1', prompt_text: '第一个自然问题', platform: 'Kimi Web', started_at: '2026-09-04T01:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'test' });
    assert.equal(context.repo.attachRunToBatchRunPlan(plan.plan_id, 'run-existing').run_id, 'run-existing');
    assert.throws(() => context.repo.attachRunToBatchRunPlan(plan.plan_id, 'run-existing'), /already has a Run/);
    assert.throws(() => context.repo.attachRunToBatchRunPlan(context.repo.listBatchRunPlans('batch-1')[1].plan_id, 'missing-run'), /Run not found/);
  } finally { close(context); }
});

test('Batch lifecycle aggregates plan outcomes without changing Core Run status semantics', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const plans = context.repo.generateBatchRunPlans('batch-1');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
    for (const plan of context.repo.listBatchRunPlans('batch-1')) {
      const current = plan.status === 'running' ? plan : context.repo.transitionBatchRunPlan(plan.plan_id, 'running');
      context.repo.transitionBatchRunPlan(current.plan_id, 'completed');
    }
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'completed');
    assert.throws(() => context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running'), /Invalid BatchRunPlan transition/);
  } finally { close(context); }
});

test('Batch becomes blocked only when every plan is an actionable prerequisite', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    for (const plan of context.repo.generateBatchRunPlans('batch-1')) {
      context.repo.transitionBatchRunPlan(plan.plan_id, plan.plan_position % 2 ? 'login_required' : 'user_action_required');
    }
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'blocked');
  } finally { close(context); }
});

test('any actionable prerequisite blocks a Batch even while other plans remain pending', () => {
  for (const actionStatus of ['login_required', 'user_action_required', 'blocked']) {
    const context = fixture();
    try {
      createBatch(context.repo);
      const [plan] = context.repo.generateBatchRunPlans('batch-1');
      const paused = context.repo.transitionBatchRunPlan(plan.plan_id, actionStatus, { at: '2026-09-04T01:02:00.000Z' });
      assert.equal(paused.finished_at, null);
      assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'blocked');
      assert.equal(context.repo.transitionBatchRunPlan(plan.plan_id, 'pending').finished_at, null);
    } finally { close(context); }
  }
});

test('action-required precedence blocks completed or failed work until the prerequisite is resolved', () => {
  for (const firstOutcome of ['completed', 'failed']) {
    const context = fixture();
    try {
      createBatch(context.repo);
      const plans = context.repo.generateBatchRunPlans('batch-1');
      context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
      assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
      context.repo.transitionBatchRunPlan(plans[0].plan_id, firstOutcome);
      context.repo.transitionBatchRunPlan(plans[1].plan_id, 'login_required');
      assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'blocked');
    } finally { close(context); }
  }
});

test('resumable plans return through pending without terminal timestamps and restart the Batch', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const plans = context.repo.generateBatchRunPlans('batch-1');
    const paused = context.repo.transitionBatchRunPlan(plans[0].plan_id, 'login_required');
    assert.equal(paused.finished_at, null);
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'blocked');
    const pending = context.repo.transitionBatchRunPlan(plans[0].plan_id, 'pending');
    assert.equal(pending.finished_at, null);
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'ready');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'completed');
    for (const plan of plans.slice(1)) {
      context.repo.transitionBatchRunPlan(plan.plan_id, 'running');
      context.repo.transitionBatchRunPlan(plan.plan_id, 'completed');
    }
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'completed');
    assert.ok(context.repo.listBatchRunPlans('batch-1')[0].finished_at);
  } finally { close(context); }
});

test('a started Batch remains running after a failed plan while later plans are pending', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const plans = context.repo.generateBatchRunPlans('batch-1');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'failed');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
  } finally { close(context); }
});

test('all failed plans aggregate to completed_with_failures', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const plans = context.repo.generateBatchRunPlans('batch-1');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
    for (const plan of plans) {
      if (plan.plan_id !== plans[0].plan_id) context.repo.transitionBatchRunPlan(plan.plan_id, 'running');
      context.repo.transitionBatchRunPlan(plan.plan_id, 'failed');
    }
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'completed_with_failures');
  } finally { close(context); }
});

test('Batch completes with failures for mixed completed and failed or skipped plans', () => {
  const context = fixture();
  try {
    createBatch(context.repo);
    const plans = context.repo.generateBatchRunPlans('batch-1');
    context.repo.transitionBatchRunPlan(plans[0].plan_id, 'running');
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'running');
    for (const [index, plan] of plans.entries()) {
      if (index > 0) context.repo.transitionBatchRunPlan(plan.plan_id, 'running');
      context.repo.transitionBatchRunPlan(plan.plan_id, index === 0 ? 'completed' : index === 1 ? 'failed' : 'skipped');
    }
    assert.equal(context.repo.aggregateObservationBatch('batch-1').status, 'completed_with_failures');
  } finally { close(context); }
});

test('schema initialization preserves an existing 1.0 Run and upgrades missing product tables idempotently', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-migration-'));
  const path = join(directory, 'monitor.sqlite');
  try {
    let db = openDatabase(path);
    let repo = new GeoRepository(db);
    repo.createRun({ run_id: 'legacy-run', prompt_id: 'legacy-prompt', prompt_text: 'preserved', platform: 'Kimi Web', started_at: '2026-09-04T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'legacy' });
    db.exec('DROP TABLE batch_run_plan; DROP TABLE observation_batch; DROP TABLE prompt; DROP TABLE prompt_set; DROP TABLE monitor_project;');
    db.close();
    db = openDatabase(path);
    repo = new GeoRepository(db);
    assert.equal(repo.getRun('legacy-run').prompt_text, 'preserved');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'monitor_project'").get());
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
