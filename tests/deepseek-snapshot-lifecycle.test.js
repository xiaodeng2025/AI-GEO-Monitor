import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekPlaywrightSession } from '../src/runtime/playwright/deepseek-playwright-session.js';

function sessionFixture({ dispatcher }) {
  const events = [];
  const page = { id: 'page' };
  const answerHandle = { id: 'answer-handle' };
  const adapter = {
    async startFreshChat() { events.push('start'); },
    async captureBaseline() { events.push('baseline'); return { responses: 0 }; },
    async submitPrompt() { events.push('submit'); },
    async waitForResponse() { events.push('complete'); },
    async locateResponseRoot() { events.push('response-root'); return { id: 'response-root' }; },
    async extractAnswer() { events.push('acquire-answer'); return { text: 'DeepSeek answer', fingerprint: 'answer-1', evidenceRoot: answerHandle }; },
    async extractCitations() { events.push('acquire-citations'); return { status: 'captured', citations: [{ position: 1, title: 'Citation', link_url: 'https://source.example/', association_method: 'trigger_bound' }] }; },
    async observeSourcePool() { events.push('acquire-sources'); return { platform_reported_source_count: 1 }; }
  };
  const evidenceProvider = {
    async materializeAnswer() { events.push('materialize-answer'); return { answer: { text: 'DeepSeek answer', html: '<p>DeepSeek answer</p>', fingerprint: 'answer-1' }, artifacts: [] }; },
    async materializeCitationEvidence() { return []; },
    async materializeTerminalContext() { return []; },
    async materializeFailure() { return []; }
  };
  return {
    events,
    session: new DeepSeekPlaywrightSession({
      runtime: { async newPage() { return page; }, async close() {} }, evidenceProvider,
      adapterFactory: () => adapter, dispatcher,
      snapshotPreparer: async (candidate) => { assert.equal(candidate, page); events.push('prepare-snapshot'); return { accepted: true }; }
    })
  };
}

test('DeepSeek lifecycle dispatches only after acquisition and preserves Snapshot artifacts', async () => {
  let call;
  const { events, session } = sessionFixture({
    dispatcher: {
      async captureWithArtifacts(input) {
        call = input;
        events.push('dispatch-snapshot');
        return {
          snapshot_result: { status: 'captured', artifact_reference: 'deepseek-dead-snapshot-v3.html', bytes: 12, captured_at: '2026-09-15T00:00:00.000Z', error: null },
          artifacts: [{ kind: 'deepseek_dead_snapshot_html', fileName: 'deepseek-dead-snapshot-v3.html', content: '<html>ok</html>' }]
        };
      }
    }
  });
  const result = await session.run({ promptText: 'new DeepSeek lifecycle query', timeoutMs: 1000 });

  assert.equal(call.platform, 'deepseek');
  assert.equal(call.context.preparation.accepted, true);
  assert.equal(events.indexOf('dispatch-snapshot') > events.indexOf('acquire-sources'), true);
  assert.equal(result.answer.text, 'DeepSeek answer');
  assert.equal(result.citations.citations[0].title, 'Citation');
  assert.deepEqual(result.observation, { platform_reported_source_count: 1 });
  assert.equal(result.snapshot_result.status, 'captured');
  assert.deepEqual(result.artifacts.citation.map(({ kind }) => kind), ['deepseek_dead_snapshot_html', 'deepseek_snapshot_result']);
});

test('DeepSeek Snapshot failure remains independent from completed acquisition', async () => {
  const { session } = sessionFixture({
    dispatcher: {
      async captureWithArtifacts() {
        return { snapshot_result: { status: 'failed', artifact_reference: null, bytes: null, captured_at: null, error: 'synthetic snapshot failure' }, artifacts: [] };
      }
    }
  });
  const result = await session.run({ promptText: 'new DeepSeek lifecycle query', timeoutMs: 1000 });

  assert.equal(result.answer.text, 'DeepSeek answer');
  assert.equal(result.citations.status, 'captured');
  assert.deepEqual(result.observation, { platform_reported_source_count: 1 });
  assert.deepEqual(result.snapshot_result, { status: 'failed', artifact_reference: null, bytes: null, captured_at: null, error: 'synthetic snapshot failure' });
  assert.equal(result.artifacts.citation.at(-1).kind, 'deepseek_snapshot_result');
});
