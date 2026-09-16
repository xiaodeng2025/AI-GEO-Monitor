import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRuntimeNeutralMonitoredRun } from '../src/core/monitored-run.js';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { RunService } from '../src/core/run-service.js';
import { openDatabase, GeoRepository } from '../src/db/repository.js';
import { DeepSeekPlaywrightSession } from '../src/runtime/playwright/deepseek-playwright-session.js';
import { YuanbaoPlaywrightSession } from '../src/runtime/playwright/yuanbao-playwright-session.js';

const prompt = { id: 'neutral-prompt', text: 'test prompt' };
const capability = {
  platform: 'DeepSeek Web', answer: true, citation_capture: 'trigger_bound',
  citation_title: false, citation_url: true, citation_domain: false, citation_position: true
};
const promptSet = { brand: { name: 'Example Brand', aliases: [] }, competitors: [] };
const yuanbaoPrompt = { id: 'yuanbao-persistence-prompt', text: 'yuanbao fixture prompt' };
const yuanbaoCapability = {
  platform: 'Tencent Yuanbao Web', answer: true, citation_capture: 'trigger_bound',
  citation_title: true, citation_url: true, citation_domain: false, citation_position: true
};

const yuanbaoReplayCitations = [
  ['1', '1', '1'], ['1', '2', '2'], ['1', '4', '3'],
  ['2', '1', '1'], ['2', '5', '2'], ['2', '6', '3'],
  ['3', '2', '1'], ['3', '4', '2'], ['3', '12', '3'],
  ['4', '6', '1'], ['4', '13', '2']
].map(([triggerPosition, sourceIndex, sourcePosition]) => ({
  position: Number(triggerPosition),
  trigger_position: Number(triggerPosition),
  source_position: Number(sourcePosition),
  source_index: sourceIndex,
  title: `Source ${sourceIndex}`,
  link_url: `https://source.example/${sourceIndex}`,
  display_domain: null,
  source_site: 'Example',
  association_method: 'trigger_bound'
}));

function evidenceBundle({ answerArtifacts = null, citationArtifacts = [] } = {}) {
  return {
    answer: { text: 'Example Brand answer', html: '<p>Example Brand answer</p>', fingerprint: 'answer-fingerprint' },
    citations: {
      status: 'captured',
      citations: [{ position: 1, title: null, link_url: 'https://source.example/', display_domain: null, association_method: 'trigger_bound' }]
    },
    observation: { platform_reported_source_count: 4 },
    artifacts: {
      answer: answerArtifacts ?? [{ kind: 'answer_html', fileName: 'answer.html', content: '<p>Example Brand answer</p>' }],
      citation: citationArtifacts
    }
  };
}

test('RunService persists a fake EvidenceProvider result without receiving a runtime handle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-neutral-store-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const artifactStore = new ArtifactStore({ rootDir: directory, projectDir: directory });
  const service = new RunService({ repository, artifactStore, parserVersion: 'test' });
  const lifecycle = service.beginRun({ prompt, platform: capability.platform, capability });
  let sessionInput;
  try {
    const result = await service.executeRuntimeNeutral({
      prompt, promptSet, lifecycle,
      sessionRunner: async (input) => {
        sessionInput = input;
        return evidenceBundle();
      }
    });

    assert.deepEqual(Object.keys(sessionInput).sort(), ['promptText', 'runId', 'timeoutMs']);
    assert.equal(result.citationStatus, 'captured');
    assert.equal(repository.getRun(result.runId).status, 'completed');
    assert.equal(db.prepare('SELECT answer_html_fragment FROM answer WHERE run_id = ?').get(result.runId).answer_html_fragment, '<p>Example Brand answer</p>');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM citation WHERE run_id = ?').get(result.runId).count, 1);
    assert.equal(db.prepare('SELECT platform_reported_source_count AS count FROM run WHERE run_id = ?').get(result.runId).count, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifact WHERE run_id = ?').get(result.runId).count, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Yuanbao historical 11-occurrence replay persists plain CitationCapture when popup artifact fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-yuanbao-persistence-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const artifactStore = new ArtifactStore({ rootDir: directory, projectDir: directory });
  const service = new RunService({ repository, artifactStore, parserVersion: 'yuanbao-test' });
  const runtimePage = { runtimeOnly: 'yuanbao-page' };
  const popupHandle = { runtimeOnly: 'yuanbao-popup' };
  const adapter = {
    async startFreshChat() {},
    async captureBaseline() { return { responseRootCount: 0 }; },
    async submitPrompt() {},
    async waitForResponse() {},
    async locateResponseRoot() { return { runtimeOnly: 'response-root' }; },
    async extractAnswer() { return { text: 'Yuanbao answer', fingerprint: 'yuanbao-answer', evidenceRoot: { runtimeOnly: 'answer' } }; },
    async observeSourcePool() { return { platform_reported_source_count: 17 }; },
    async extractCitations() { return { status: 'captured', citations: yuanbaoReplayCitations, panel: popupHandle }; }
  };
  const provider = {
    async materializeAnswer(input) {
      return { answer: { text: input.text, html: '<div>Yuanbao answer</div>', fingerprint: input.fingerprint }, artifacts: [] };
    },
    async materializeCitationEvidence() {
      throw new Error('supplementary popup artifact unavailable');
    }
  };
  const session = new YuanbaoPlaywrightSession({
    runtime: { async newPage() { return runtimePage; }, async close() {} },
    evidenceProvider: provider,
    adapterFactory: (page) => { assert.equal(page, runtimePage); return adapter; }
  });
  const lifecycle = service.beginRun({ prompt: yuanbaoPrompt, platform: yuanbaoCapability.platform, capability: yuanbaoCapability });
  assert.equal(yuanbaoReplayCitations.length, 11);
  assert.equal(new Set(yuanbaoReplayCitations.map((citation) => citation.source_index)).size, 7);

  try {
    const result = await service.executeRuntimeNeutral({
      prompt: yuanbaoPrompt,
      promptSet,
      lifecycle,
      sessionRunner: (input) => session.run(input)
    });

    const rows = db.prepare('SELECT position, link_url, association_method FROM citation WHERE run_id = ? ORDER BY rowid').all(result.runId);
    assert.equal(result.citationStatus, 'captured');
    assert.equal(rows.length, 11);
    assert.equal(new Set(rows.map((row) => row.link_url)).size, 7);
    assert.equal(rows.filter((row) => row.link_url === 'https://source.example/1').length, 2);
    assert.deepEqual(rows.map((row) => row.position), [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4]);
    assert.ok(rows.every((row) => row.association_method === 'trigger_bound'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM answer WHERE run_id = ?').get(result.runId).count, 1);
    assert.equal(db.prepare('SELECT platform_reported_source_count FROM run WHERE run_id = ?').get(result.runId).platform_reported_source_count, 17);
    assert.equal(repository.getRun(result.runId).status, 'completed');
  } finally {
    await session.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Yuanbao replay diagnostic artifact persists without changing parse-failed Citation semantics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-yuanbao-diagnostics-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const artifactStore = new ArtifactStore({ rootDir: directory, projectDir: directory });
  const service = new RunService({ repository, artifactStore, parserVersion: 'yuanbao-test' });
  const diagnostics = {
    scope: 'accepted_response',
    trigger_count: 5,
    first_failure: { trigger_position: 3, expected_idx: '11', stage: 'popup_reacquire' },
    triggers: [],
    parsed_citations: []
  };
  const lifecycle = service.beginRun({ prompt: yuanbaoPrompt, platform: yuanbaoCapability.platform, capability: yuanbaoCapability });

  try {
    const result = await service.executeRuntimeNeutral({
      prompt: yuanbaoPrompt,
      promptSet,
      lifecycle,
      sessionRunner: async () => ({
        answer: { text: 'Yuanbao answer', html: '<div>Yuanbao answer</div>', fingerprint: 'yuanbao-answer' },
        citations: { status: 'parse_failed', citations: [] },
        observation: { platform_reported_source_count: 32 },
        artifacts: {
          answer: [],
          citation: [{
            kind: 'citation_replay_diagnostics',
            fileName: 'citation-replay-diagnostics.json',
            content: JSON.stringify(diagnostics)
          }]
        }
      })
    });

    const storedArtifact = db.prepare('SELECT kind, path FROM artifact WHERE run_id = ?').get(result.runId);
    assert.equal(result.citationStatus, 'parse_failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM citation WHERE run_id = ?').get(result.runId).count, 0);
    assert.equal(storedArtifact.kind, 'citation_replay_diagnostics');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, storedArtifact.path), 'utf8')), diagnostics);
    assert.equal(db.prepare('SELECT platform_reported_source_count FROM run WHERE run_id = ?').get(result.runId).platform_reported_source_count, 32);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('DeepSeek Playwright session consumes handles before returning a plain result', async () => {
  const page = { runtimeOnly: true };
  const responseHandle = { runtimeOnly: true };
  const events = [];
  let receivedHandle;
  const adapter = {
    async startFreshChat() { events.push('fresh-chat'); },
    async captureBaseline() { events.push('baseline'); return { runtimeNeutral: true }; },
    async submitPrompt() { events.push('submit'); },
    async waitForResponse() { events.push('complete'); },
    async locateResponseRoot() { events.push('locate'); return responseHandle; },
    async extractAnswer() { events.push('answer'); return { text: 'answer', fingerprint: 'fingerprint', evidenceRoot: responseHandle }; },
    async extractCitations() { events.push('citations'); return { status: 'not_displayed', citations: [] }; },
    async observeSourcePool() { events.push('observation'); return { platform_reported_source_count: 6 }; }
  };
  const evidenceProvider = {
    async materializeAnswer(input) {
      receivedHandle = input.handle;
      events.push('materialize-answer');
      return { answer: { text: input.text, html: '<p>answer</p>', fingerprint: input.fingerprint }, artifacts: [] };
    },
    async materializeCitationEvidence() { events.push('materialize-citations'); return []; },
    async materializeFailure() { return []; }
  };
  const runtime = {
    async newPage() { events.push('new-page'); return page; },
    async close() { events.push('cleanup'); }
  };
  const session = new DeepSeekPlaywrightSession({
    runtime, evidenceProvider, adapterFactory: (candidate) => {
      assert.equal(candidate, page);
      return adapter;
    },
    snapshotPreparer: async () => { events.push('prepare-snapshot'); return { accepted: true }; },
    dispatcher: {
      async captureWithArtifacts(input) {
        events.push('dispatch-snapshot');
        assert.equal(input.platform, 'deepseek');
        assert.deepEqual(input.context.preparation, { accepted: true });
        return {
          snapshot_result: { status: 'captured', artifact_reference: 'deepseek-dead-snapshot-v3.html', bytes: 12, captured_at: '2026-09-15T00:00:00.000Z', error: null },
          artifacts: []
        };
      }
    }
  });

  const result = await session.run({ promptText: 'question', timeoutMs: 1000 });
  assert.equal(receivedHandle, responseHandle);
  assert.deepEqual(result, {
    answer: { text: 'answer', html: '<p>answer</p>', fingerprint: 'fingerprint' },
    citations: { status: 'not_displayed', citations: [] },
    observation: { platform_reported_source_count: 6 },
    snapshot_result: { status: 'captured', artifact_reference: 'deepseek-dead-snapshot-v3.html', bytes: 12, captured_at: '2026-09-15T00:00:00.000Z', error: null },
    artifacts: {
      answer: [],
      citation: [{
        kind: 'deepseek_snapshot_result', fileName: 'deepseek-snapshot-result.json',
        content: '{\n  "status": "captured",\n  "artifact_reference": "deepseek-dead-snapshot-v3.html",\n  "bytes": 12,\n  "captured_at": "2026-09-15T00:00:00.000Z",\n  "error": null\n}\n'
      }]
    }
  });
  assert.equal('evidenceRoot' in result, false);
  assert.equal('panel' in result, false);
  assert.equal(events.includes('cleanup'), false);
  await session.close();
  assert.deepEqual(events, ['new-page', 'fresh-chat', 'baseline', 'submit', 'complete', 'locate', 'answer', 'materialize-answer', 'citations', 'observation', 'materialize-citations', 'prepare-snapshot', 'dispatch-snapshot', 'cleanup']);
});

test('Citation rows survive terminal context screenshot persistence failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-citation-artifact-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const artifactStore = new ArtifactStore({ rootDir: directory, projectDir: directory });
  const persistMaterialized = artifactStore.persistMaterialized.bind(artifactStore);
  artifactStore.persistMaterialized = async (runId, payloads) => {
    if (payloads.some(({ kind }) => kind === 'terminal_context_screenshot')) throw new Error('supplementary screenshot unavailable');
    return persistMaterialized(runId, payloads);
  };
  const service = new RunService({ repository, artifactStore, parserVersion: 'test' });
  const lifecycle = service.beginRun({ prompt, platform: capability.platform, capability });
  try {
    const result = await service.executeRuntimeNeutral({
      prompt, promptSet, lifecycle,
      sessionRunner: async () => evidenceBundle({ citationArtifacts: [{ kind: 'terminal_context_screenshot', fileName: 'terminal-context.png', content: Buffer.from('png') }] })
    });

    assert.equal(repository.getRun(result.runId).status, 'completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM citation WHERE run_id = ?').get(result.runId).count, 1);
    assert.equal(db.prepare('SELECT citation_status FROM run WHERE run_id = ?').get(result.runId).citation_status, 'captured');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifact WHERE run_id = ?').get(result.runId).count, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Failure screenshot is best-effort and terminal persistence completes without a runtime object', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-failure-'));
  const db = openDatabase(join(directory, 'monitor.sqlite'));
  const repository = new GeoRepository(db);
  const service = new RunService({ repository, artifactStore: new ArtifactStore({ rootDir: directory }), parserVersion: 'test' });
  const events = [];
  const finishRun = repository.finishRun.bind(repository);
  repository.finishRun = (run) => { events.push('finish'); return finishRun(run); };
  try {
    let caught;
    try {
      await executeRuntimeNeutralMonitoredRun({
        service, platform: capability.platform, capability, prompt, promptSet,
        sessionRunner: async () => {
          const error = new Error('simulated runtime failure');
          error.failureArtifacts = [];
          throw error;
        },
        closeSession: async () => { events.push('cleanup'); }
      });
    } catch (error) { caught = error; }

    assert.equal(caught.answerStatus, 'failed');
    assert.equal(repository.getRun(caught.runId).status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifact WHERE run_id = ?').get(caught.runId).count, 1);
    assert.ok(events.indexOf('finish') < events.indexOf('cleanup'));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
