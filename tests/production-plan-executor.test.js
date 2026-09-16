import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { RunService } from '../src/core/run-service.js';
import { ProductionPlanExecutor } from '../src/application/production-plan-executor.js';
import { PlatformRuntimeFactory } from '../src/application/platform-runtime-factory.js';
import { MonitoringApplication } from '../src/application/monitoring-application.js';
import { openDatabase, GeoRepository } from '../src/db/repository.js';

const capabilities = {
  kimi: { platform: 'Kimi Web', answer: true, citation_capture: 'trigger_bound', citation_title: true, citation_url: true, citation_domain: true, citation_position: true },
  yuanbao: { platform: 'Tencent Yuanbao Web', answer: true, citation_capture: 'trigger_bound', citation_title: true, citation_url: true, citation_domain: false, citation_position: true },
  deepseek: { platform: 'DeepSeek Web', answer: true, citation_capture: 'trigger_bound', citation_title: false, citation_url: true, citation_domain: false, citation_position: true }
};

function makeContext() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-bridge-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const artifactStore = new ArtifactStore({ rootDir: join(directory, 'artifacts') });
  return { directory, db, repository, artifactStore };
}

function plan(platform) { return { plan_id: `plan-${platform}`, prompt_id: 'prompt-1', prompt_label: 'Prompt', prompt_text: 'What is the answer?', platform }; }
const snapshot = { project: { brand: { name: 'Brand', aliases: [] }, competitors: [] } };

function runtimeFactory(context, behavior = {}) {
  return {
    create(platform) {
      if (!capabilities[platform]) throw new Error(`Unsupported production platform: ${platform}`);
      const service = new RunService({ repository: context.repository, artifactStore: context.artifactStore, parserVersion: `${platform}-test`, timeoutMs: 100 });
      const session = {
        async run() {
          const result = behavior[platform] ?? 'success';
          if (result === 'login') { const error = new Error('Manual login required.'); error.code = 'MANUAL_LOGIN_REQUIRED'; throw error; }
          if (result === 'failure') throw new Error(`${platform} failed.`);
          return { answer: { text: 'Brand answer', html: '<p>Brand answer</p>', fingerprint: 'fingerprint' }, citations: { status: 'not_displayed', citations: [] }, observation: { platform_reported_source_count: null }, artifacts: { answer: [], citation: [] } };
        },
        async close() {}
      };
      return { capability: capabilities[platform], service, session, closeSession: () => session.close() };
    }
  };
}

function close(context) { context.db.close(); rmSync(context.directory, { recursive: true, force: true }); }

test('ProductionPlanExecutor maps all platform successes to completed with Core run IDs', async () => {
  const context = makeContext();
  try {
    const executor = new ProductionPlanExecutor({ runtimeFactory: runtimeFactory(context) });
    for (const platform of ['kimi', 'yuanbao', 'deepseek']) {
      const outcome = await executor.execute(plan(platform), snapshot);
      assert.equal(outcome.status, 'completed');
      assert.ok(outcome.run_id);
      assert.equal(context.repository.getRun(outcome.run_id).status, 'completed');
    }
  } finally { close(context); }
});

test('Kimi typed manual-login failure maps to login_required and preserves its failed Core Run', async () => {
  const context = makeContext();
  try {
    const executor = new ProductionPlanExecutor({ runtimeFactory: runtimeFactory(context, { kimi: 'login' }) });
    const outcome = await executor.execute(plan('kimi'), snapshot);
    assert.equal(outcome.status, 'login_required');
    assert.ok(outcome.run_id);
    assert.equal(context.repository.getRun(outcome.run_id).status, 'failed');
  } finally { close(context); }
});

test('other Kimi, Yuanbao, and DeepSeek failures map to failed and retain run IDs', async () => {
  const context = makeContext();
  try {
    const executor = new ProductionPlanExecutor({ runtimeFactory: runtimeFactory(context, { kimi: 'failure', yuanbao: 'failure', deepseek: 'failure' }) });
    for (const platform of ['kimi', 'yuanbao', 'deepseek']) {
      const outcome = await executor.execute(plan(platform), snapshot);
      assert.equal(outcome.status, 'failed');
      assert.ok(outcome.run_id);
      assert.equal(context.repository.getRun(outcome.run_id).status, 'failed');
    }
  } finally { close(context); }
});

test('factory creation failure returns failed without fabricating a Core run', async () => {
  const executor = new ProductionPlanExecutor({ runtimeFactory: { create() { throw new Error('construction failed'); } } });
  const outcome = await executor.execute(plan('kimi'), snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal('run_id' in outcome, false);
});

test('PlatformRuntimeFactory dispatches only the three supported platform keys', () => {
  const context = makeContext();
  try {
    const factory = new PlatformRuntimeFactory({ repository: context.repository, artifactStore: context.artifactStore, profilesRoot: context.directory });
    for (const platform of ['kimi', 'yuanbao', 'deepseek']) assert.equal(factory.create(platform).capability.platform.length > 0, true);
    assert.throws(() => factory.create('unsupported'), /Unsupported production platform/);
  } finally { close(context); }
});

test('production runtime factory uses native sizing for Kimi and preserves other platform sizing', () => {
  const context = makeContext();
  try {
    const factory = new PlatformRuntimeFactory({ repository: context.repository, artifactStore: context.artifactStore, profilesRoot: context.directory });
    assert.equal(factory.create('kimi').session.runtime.contextOptions().viewport, null);
    assert.equal(factory.create('yuanbao').session.runtime.contextOptions().viewport, null);
    assert.equal(factory.create('deepseek').session.runtime.contextOptions().viewport, null);
    assert.deepEqual(factory.create('deepseek').session.runtime.contextOptions().args, ['--start-maximized']);
  } finally { close(context); }
});

test('MonitoringApplication consumes ProductionPlanExecutor outcomes without runtime handles', async () => {
  const context = makeContext();
  try {
    const executor = new ProductionPlanExecutor({ runtimeFactory: runtimeFactory(context) });
    const app = new MonitoringApplication({ repository: context.repository, planExecutor: executor });
    const project = app.createProject({ project_id: 'project-1', name: 'Project', brand_name: 'Brand', brand_aliases: [], competitors: [], selected_platforms: ['kimi'] });
    const promptSet = app.createPromptSet({ prompt_set_id: 'set-1', project_id: project.project_id, name: 'Prompts' });
    app.addPrompt({ prompt_id: 'prompt-1', prompt_set_id: promptSet.prompt_set_id, text: 'What is the answer?', position: 0 });
    const batch = app.createBatch({ projectId: project.project_id, promptSetId: promptSet.prompt_set_id, batchId: 'batch-1' });
    assert.equal((await app.startBatch(batch.batch.batch_id)).status, 'completed');
    const persistedPlan = app.listBatchRunPlans('batch-1')[0];
    assert.equal(persistedPlan.status, 'completed');
    assert.equal('answer' in persistedPlan, false);
    assert.equal('citations' in persistedPlan, false);
  } finally { close(context); }
});

test('default ProductionPlanExecutor keeps automatic close without a review hook', async () => {
  const context = makeContext();
  const events = [];
  try {
    const factory = runtimeFactory(context);
    const originalCreate = factory.create.bind(factory);
    factory.create = (platform) => {
      const runtime = originalCreate(platform);
      const close = runtime.closeSession;
      runtime.closeSession = async () => { events.push('close'); await close(); };
      return runtime;
    };
    const executor = new ProductionPlanExecutor({ runtimeFactory: factory });
    const outcome = await executor.execute(plan('kimi'), snapshot);
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(events, ['close']);
  } finally { close(context); }
});

test('validation review hook runs after terminal persistence and before close', async () => {
  const context = makeContext();
  const events = [];
  try {
    const factory = runtimeFactory(context);
    const originalCreate = factory.create.bind(factory);
    factory.create = (platform) => {
      const runtime = originalCreate(platform);
      const close = runtime.closeSession;
      runtime.closeSession = async () => { events.push('close'); await close(); };
      return runtime;
    };
    const reviewed = [];
    const executor = new ProductionPlanExecutor({
      runtimeFactory: factory,
      onTerminalPersisted: async (info) => {
        events.push('hold');
        reviewed.push(info);
        assert.equal(context.repository.getRun(info.run_id).status, 'completed');
      }
    });
    const outcome = await executor.execute(plan('kimi'), snapshot);
    assert.equal(outcome.status, 'completed');
    assert.ok(outcome.run_id);
    assert.equal(reviewed[0].status, 'completed');
    assert.equal(reviewed[0].run_id, outcome.run_id);
    assert.deepEqual(events, ['hold', 'close']);
  } finally { close(context); }
});

test('validation review hook holds a live-session failure without changing the product outcome', async () => {
  const context = makeContext();
  const events = [];
  try {
    const factory = runtimeFactory(context, { kimi: 'failure' });
    const originalCreate = factory.create.bind(factory);
    factory.create = (platform) => {
      const runtime = originalCreate(platform);
      const close = runtime.closeSession;
      runtime.closeSession = async () => { events.push('close'); await close(); };
      return runtime;
    };
    const reviewed = [];
    const executor = new ProductionPlanExecutor({
      runtimeFactory: factory,
      onTerminalPersisted: async (info) => {
        events.push('hold');
        reviewed.push(info);
        assert.equal(context.repository.getRun(info.run_id).status, 'failed');
      }
    });
    const outcome = await executor.execute(plan('kimi'), snapshot);
    assert.equal(outcome.status, 'failed');
    assert.ok(outcome.run_id);
    assert.equal(reviewed[0].status, 'failed');
    assert.equal(reviewed[0].run_id, outcome.run_id);
    assert.deepEqual(events, ['hold', 'close']);
  } finally { close(context); }
});

test('pre-session factory failure does not invoke validation review or fabricate a Run', async () => {
  const events = [];
  const executor = new ProductionPlanExecutor({
    runtimeFactory: { create() { throw new Error('construction failed'); } },
    onTerminalPersisted: async () => { events.push('hold'); }
  });
  const outcome = await executor.execute(plan('kimi'), snapshot);
  assert.equal(outcome.status, 'failed');
  assert.equal('run_id' in outcome, false);
  assert.deepEqual(events, []);
});

test('validation review hook preserves sequential Batch order', async () => {
  const context = makeContext();
  const events = [];
  try {
    const executor = new ProductionPlanExecutor({ runtimeFactory: runtimeFactory(context), onTerminalPersisted: async (info) => { events.push(info.platform); } });
    const app = new MonitoringApplication({ repository: context.repository, planExecutor: executor });
    const project = app.createProject({ project_id: 'review-project', name: 'Project', brand_name: 'Brand', brand_aliases: [], competitors: [], selected_platforms: ['kimi', 'yuanbao', 'deepseek'] });
    const promptSet = app.createPromptSet({ prompt_set_id: 'review-set', project_id: project.project_id, name: 'Prompts' });
    app.addPrompt({ prompt_id: 'review-prompt', prompt_set_id: promptSet.prompt_set_id, text: 'What is the answer?', position: 0 });
    const batch = app.createBatch({ projectId: project.project_id, promptSetId: promptSet.prompt_set_id, batchId: 'review-batch' });
    assert.equal((await app.startBatch(batch.batch.batch_id)).status, 'completed');
    assert.deepEqual(events, ['kimi', 'yuanbao', 'deepseek']);
  } finally { close(context); }
});
