import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitoringApplication } from '../src/application/monitoring-application.js';
import { openDatabase, GeoRepository } from '../src/db/repository.js';

function fixture(script = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-app-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repo = new GeoRepository(db);
  const calls = [];
  let runNumber = 0;
  const remaining = new Map(Object.entries(script).map(([position, outcomes]) => [Number(position), [...outcomes]]));
  const executor = {
    async execute(plan) {
      calls.push(plan.plan_position);
      const next = remaining.get(plan.plan_position)?.shift() ?? { status: 'completed' };
      if (next.throw) throw new Error(next.throw);
      const outcome = typeof next === 'string' ? { status: next } : next;
      if (outcome.status === 'completed' || outcome.run_id) {
        const runId = outcome.run_id ?? `run-${runNumber++}`;
        repo.createRun({ run_id: runId, prompt_id: plan.prompt_id, prompt_text: plan.prompt_text, platform: plan.platform,
          started_at: '2026-09-05T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'fake' });
        return { ...outcome, run_id: runId };
      }
      return outcome;
    }
  };
  const app = new MonitoringApplication({ repository: repo, planExecutor: executor, parserVersion: 'app-test', runtimeVersion: 'fake-runtime' });
  const project = app.createProject({ project_id: 'project-1', name: 'Project', brand_name: 'Brand', brand_aliases: ['B'], competitors: [{ name: 'Other', aliases: ['O'] }], selected_platforms: ['kimi', 'yuanbao', 'deepseek'] });
  const set = app.createPromptSet({ prompt_set_id: 'set-1', project_id: project.project_id, name: 'Prompts' });
  app.addPrompt({ prompt_id: 'prompt-1', prompt_set_id: set.prompt_set_id, text: 'first', position: 0 });
  app.addPrompt({ prompt_id: 'prompt-2', prompt_set_id: set.prompt_set_id, label: 'Second', text: 'second', position: 1 });
  return { directory, db, repo, app, calls };
}

function close({ db, directory }) { db.close(); rmSync(directory, { recursive: true, force: true }); }
function createBatch(app, batchId = 'batch-1') { return app.createBatch({ projectId: 'project-1', promptSetId: 'set-1', batchId }); }

test('MonitoringApplication atomically returns a ready Batch with immutable plans and no runtime imports', () => {
  const context = fixture();
  try {
    const { batch, plans } = createBatch(context.app);
    assert.equal(batch.status, 'ready');
    assert.equal(plans.length, 6);
    assert.equal(context.app.listBatchRunPlans(batch.batch_id).length, 6);
    context.app.updateProject('project-1', { brand_name: 'Changed', selected_platforms: ['kimi'] });
    context.app.updatePrompt('prompt-1', { text: 'changed' });
    const persisted = context.app.getBatch('batch-1');
    assert.equal(persisted.snapshot.project.brand.name, 'Brand');
    assert.equal(persisted.snapshot.prompts[0].text, 'first');
    assert.deepEqual(persisted.snapshot.selected_platforms, ['kimi', 'yuanbao', 'deepseek']);
  } finally { close(context); }
});

test('sequential all-success Batch attaches existing Runs in stable plan order without duplicates', async () => {
  const context = fixture();
  try {
    createBatch(context.app);
    assert.equal((await context.app.startBatch('batch-1')).status, 'completed');
    assert.deepEqual(context.calls, [0, 1, 2, 3, 4, 5]);
    const plans = context.app.listBatchRunPlans('batch-1');
    assert.ok(plans.every((plan) => plan.status === 'completed' && plan.run_id && context.repo.getRun(plan.run_id)));
    await context.app.startBatch('batch-1');
    assert.deepEqual(context.calls, [0, 1, 2, 3, 4, 5]);
  } finally { close(context); }
});

test('failed and skipped plans continue sequential execution and produce completed_with_failures', async () => {
  const context = fixture({ 1: ['failed'], 3: ['skipped'] });
  try {
    createBatch(context.app);
    assert.equal((await context.app.startBatch('batch-1')).status, 'completed_with_failures');
    assert.deepEqual(context.calls, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(context.app.listBatchRunPlans('batch-1').map((plan) => plan.status), ['completed', 'failed', 'completed', 'skipped', 'completed', 'completed']);
  } finally { close(context); }
});

test('login_required pauses the Batch and resume executes only the paused and later plans', async () => {
  const context = fixture({ 1: ['login_required', 'completed'] });
  try {
    createBatch(context.app);
    assert.equal((await context.app.startBatch('batch-1')).status, 'blocked');
    assert.deepEqual(context.calls, [0, 1]);
    assert.deepEqual(context.app.listBatchRunPlans('batch-1').map((plan) => plan.status), ['completed', 'login_required', 'pending', 'pending', 'pending', 'pending']);
    assert.equal((await context.app.resumeBatch('batch-1')).status, 'completed');
    assert.deepEqual(context.calls, [0, 1, 1, 2, 3, 4, 5]);
  } finally { close(context); }
});

test('user_action_required and blocked outcomes each pause and resume sequential execution', async () => {
  for (const status of ['user_action_required', 'blocked']) {
    const context = fixture({ 0: [status, 'completed'] });
    try {
      createBatch(context.app);
      assert.equal((await context.app.startBatch('batch-1')).status, 'blocked');
      assert.deepEqual(context.calls, [0]);
      assert.equal((await context.app.resumeBatch('batch-1')).status, 'completed');
      assert.deepEqual(context.calls, [0, 0, 1, 2, 3, 4, 5]);
    } finally { close(context); }
  }
});

test('an unexpected Application execution exception blocks the current plan without losing completed work', async () => {
  const context = fixture({ 1: [{ throw: 'executor disconnected' }] });
  try {
    createBatch(context.app);
    await assert.rejects(() => context.app.startBatch('batch-1'), /Application execution error/);
    const plans = context.app.listBatchRunPlans('batch-1');
    assert.equal(plans[0].status, 'completed');
    assert.equal(plans[1].status, 'blocked');
    assert.equal(plans[1].finished_at, null);
    assert.equal(plans[2].status, 'pending');
    assert.equal(context.app.getBatchStatus('batch-1').status, 'blocked');
  } finally { close(context); }
});
