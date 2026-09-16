import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSnapshotDispatcher, captureSnapshotIsolated } from '../src/runtime/playwright/snapshot-registry.js';

const platforms = ['deepseek', 'doubao', 'yuanbao', 'wenxin'];

test('Snapshot dispatcher selects each platform-owned handler and returns artifact-only metadata', async () => {
  const calls = [];
  const dispatcher = createSnapshotDispatcher({
    now: () => '2026-09-15T00:00:00.000Z',
    handlers: Object.fromEntries(platforms.map((platform) => [platform, async (context) => {
      calls.push({ platform, context });
      return { status: 'captured', artifact: { path: `/artifacts/${platform}.mhtml`, bytes: 100 + platform.length } };
    }]))
  });

  for (const platform of platforms) {
    const result = await dispatcher.capture({ platform, context: { page: { fake: true } } });
    assert.deepEqual(result, {
      status: 'captured', artifact_reference: `/artifacts/${platform}.mhtml`, bytes: 100 + platform.length,
      captured_at: '2026-09-15T00:00:00.000Z', error: null
    });
  }
  assert.deepEqual(calls.map(({ platform }) => platform), platforms);
});

test('Snapshot dispatcher rejects an unknown platform without fallback', async () => {
  const dispatcher = createSnapshotDispatcher({ handlers: { deepseek: async () => ({ status: 'captured' }) } });
  await assert.rejects(() => dispatcher.capture({ platform: 'unknown', context: {} }), /Unsupported snapshot platform: unknown/);
});

test('Snapshot dispatcher retains native artifact payloads separately from its public result', async () => {
  const artifact = { kind: 'deepseek_dead_snapshot_html', fileName: 'snapshot.html', content: '<html />' };
  const dispatcher = createSnapshotDispatcher({
    now: () => '2026-09-15T00:00:00.000Z',
    handlers: { deepseek: async () => ({ status: 'captured', artifacts: [artifact] }) }
  });
  const dispatched = await dispatcher.captureWithArtifacts({ platform: 'deepseek' });

  assert.deepEqual(dispatched.snapshot_result, {
    status: 'captured', artifact_reference: 'snapshot.html', bytes: 8,
    captured_at: '2026-09-15T00:00:00.000Z', error: null
  });
  assert.deepEqual(dispatched.artifacts, [artifact]);
});

test('Snapshot failure is isolated from a completed acquisition result', async () => {
  const acquisitionResult = Object.freeze({ status: 'completed', answer: { text: 'preserved' } });
  const dispatcher = createSnapshotDispatcher({
    handlers: { deepseek: async () => { throw new Error('synthetic snapshot failure'); } }
  });
  const outcome = await captureSnapshotIsolated({ acquisitionResult, dispatcher, platform: 'deepseek', context: {} });

  assert.equal(outcome.acquisition_result, acquisitionResult);
  assert.deepEqual(outcome.snapshot_result, {
    status: 'failed', artifact_reference: null, bytes: null, captured_at: null, error: 'synthetic snapshot failure'
  });
});

test('Snapshot dispatcher stays independent of DOM, DB, GEO backend, and query submission', async () => {
  const source = await readFile(new URL('../src/runtime/playwright/snapshot-registry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /querySelector|\.locator\(|\.click\(|submitPrompt|repository|database|GEO Delivery/i);
});
