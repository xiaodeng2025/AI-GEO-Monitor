import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';
import {
  InMemoryObservationSnapshotTransport,
  ObservationSnapshotBridge,
  PageHandleRegistry
} from '../src/runtime/playwright/observation-snapshot-bridge.js';
import { PlaywrightExtensionObservationTransport } from '../src/runtime/playwright/playwright-extension-observation-transport.js';

const platforms = ['deepseek', 'doubao', 'yuanbao', 'wenxin'];

function envelope(platform, suffix = platform) {
  const observation = Object.freeze({ platform, conversation_url: `https://${platform}.example/chat/${suffix}`, native_payload: { untouched: true } });
  return {
    trigger: { type: 'observation_snapshot_ready', platform, observation_id: `observation-${suffix}`, session_id: 'session-1', page_id: `page-${platform}`, conversation_url: observation.conversation_url, readiness: 'observation_ready' },
    observation
  };
}

function fixture() {
  const calls = [];
  const registry = new PageHandleRegistry();
  for (const platform of platforms) registry.register({ session_id: 'session-1', page_id: `page-${platform}`, page: { platform } });
  const dispatcher = {
    async captureWithArtifacts({ platform, context }) {
      calls.push({ platform, page: context.page });
      return {
        snapshot_result: { status: 'captured', artifact_reference: `${platform}.mhtml`, bytes: 10, captured_at: '2026-09-15T00:00:00.000Z', error: null },
        artifacts: [{ kind: `${platform}_snapshot`, fileName: `${platform}.mhtml`, content: 'snapshot' }]
      };
    }
  };
  return { calls, bridge: new ObservationSnapshotBridge({ pageRegistry: registry, dispatcher }) };
}

test('Observation bridge preserves all platform observations and dispatches through the registry', async () => {
  const { calls, bridge } = fixture();
  const transport = new InMemoryObservationSnapshotTransport();
  bridge.attach(transport);
  for (const platform of platforms) {
    const input = envelope(platform);
    const [outcome] = await transport.publish(input);
    assert.equal(outcome.observation, input.observation);
    assert.equal(outcome.snapshot_result.status, 'captured');
    assert.equal(outcome.snapshot_result.artifact_reference, `${platform}.mhtml`);
  }
  assert.deepEqual(calls.map(({ platform }) => platform), platforms);
});

test('Observation bridge isolates missing Pages, Snapshot failures, and unknown platforms', async () => {
  const { bridge } = fixture();
  const missing = envelope('doubao', 'missing');
  missing.trigger.page_id = 'unregistered-page';
  const missingOutcome = await bridge.receive(missing);
  assert.equal(missingOutcome.observation, missing.observation);
  assert.match(missingOutcome.snapshot_result.error, /No local Page/);

  const failureBridge = new ObservationSnapshotBridge({
    pageRegistry: { resolve: () => ({ fake: true }) },
    dispatcher: { async captureWithArtifacts() { return { snapshot_result: { status: 'failed', artifact_reference: null, bytes: null, captured_at: null, error: 'synthetic failure' }, artifacts: [] }; } }
  });
  const failure = await failureBridge.receive(envelope('doubao', 'failure'));
  assert.equal(failure.observation.native_payload.untouched, true);
  assert.equal(failure.snapshot_result.error, 'synthetic failure');

  const unknownBridge = new ObservationSnapshotBridge({
    pageRegistry: { resolve: () => ({ fake: true }) },
    dispatcher: { async captureWithArtifacts({ platform }) { throw new Error(`Unsupported snapshot platform: ${platform}`); } }
  });
  const unknown = await unknownBridge.receive(envelope('unknown', 'unknown'));
  assert.match(unknown.snapshot_result.error, /Unsupported snapshot platform: unknown/);
});

test('Observation bridge dedupes the same observation identity without a second capture', async () => {
  const { calls, bridge } = fixture();
  const input = envelope('doubao', 'duplicate');
  const [first, second] = await Promise.all([bridge.receive(input), bridge.receive(input)]);
  assert.equal(first, second);
  assert.equal(calls.length, 1);
});

test('Extension trigger projects only minimal bridge context and cannot affect observation publication', async () => {
  const triggerSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/runtime.js', import.meta.url), 'utf8');
  const published = [];
  const context = vm.createContext({
    globalThis: null,
    URL,
    __AI_GEO_UNIFIED_PLATFORM_REGISTRY__: [{ id: 'doubao' }],
    __AI_GEO_UNIFIED_PLATFORM_ROUTER__: { resolvePlatform: () => ({ id: 'doubao' }) },
    __AI_GEO_OBSERVATION_SNAPSHOT_CONTEXT__: { session_id: 'session-1', page_id: 'page-doubao' },
    __AI_GEO_OBSERVATION_SNAPSHOT_TRANSPORT__: { publish: (message) => published.push(message) }
  });
  context.globalThis = context;
  vm.runInContext(triggerSource, context);
  vm.runInContext(runtimeSource, context);
  const observation = {
    platform: 'doubao',
    conversation_url: 'https://www.doubao.com/chat/created',
    observation_status: 'stable',
    question: { status: 'confirmed' },
    answer: { status: 'confirmed' }
  };
  assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__.activatePlatform('doubao').publishObservation(observation, 'observation-1'), true);
  assert.equal(published.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(published[0].trigger)), {
    type: 'observation_snapshot_ready', platform: 'doubao', observation_id: 'observation-1', session_id: 'session-1', page_id: 'page-doubao',
    conversation_url: 'https://www.doubao.com/chat/created', readiness: 'observation_ready'
  });
  assert.equal(published[0].observation, observation);
});

test('Extension trigger leaves observations without a current conversation URL published but not Snapshot-ready', async () => {
  const triggerSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js', import.meta.url), 'utf8');
  const published = [];
  const context = vm.createContext({ globalThis: null, URL, __AI_GEO_OBSERVATION_SNAPSHOT_TRANSPORT__: { publish: (message) => published.push(message) } });
  context.globalThis = context;
  vm.runInContext(triggerSource, context);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { platform: 'doubao', conversation_url: '' }, observationId: 'no-conversation' }), false);
  assert.equal(published.length, 0);
});

test('Doubao trigger accepts a stable confirmed final observation even while the response probe is active', async () => {
  const triggerSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js', import.meta.url), 'utf8');
  const published = [];
  const context = vm.createContext({ globalThis: null, URL, __AI_GEO_OBSERVATION_SNAPSHOT_TRANSPORT__: { publish: (message) => published.push(message) } });
  context.globalThis = context;
  vm.runInContext(triggerSource, context);
  const base = { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', observation_status: 'stable', question: { status: 'confirmed' } };
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, conversation_url: '' , answer: { status: 'confirmed' } }, observationId: 'no-conversation' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, conversation_url: 'https://www.doubao.com/chat/' , answer: { status: 'confirmed' } }, observationId: 'homepage' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, conversation_url: 'https://www.doubao.com/chat/current/extra' , answer: { status: 'confirmed' } }, observationId: 'non-conversation' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, observation_status: 'unstable', answer: { status: 'confirmed' } }, observationId: 'unstable' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, question: { status: 'candidate' }, answer: { status: 'confirmed' } }, observationId: 'question-in-progress' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, question: { status: 'unknown' }, answer: { status: 'confirmed' } }, observationId: 'question-unknown' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, answer: { status: 'candidate' } }, observationId: 'answer-in-progress' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, answer: { status: 'unknown' } }, observationId: 'answer-unknown' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: { ...base, answer: { status: 'confirmed' }, response_observation: { status: 'active' } }, observationId: 'response-active' }), true);
  assert.equal(published.length, 1);
});

test('Doubao Snapshot-ready trigger is sent to the Extension runtime unchanged', async () => {
  const triggerSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js', import.meta.url), 'utf8');
  const sent = [];
  const context = vm.createContext({ globalThis: null, URL, chrome: { runtime: { sendMessage: (message) => sent.push(message) } } });
  context.globalThis = context;
  vm.runInContext(triggerSource, context);
  const observation = { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/final', observation_status: 'stable', question: { status: 'confirmed' }, answer: { status: 'confirmed' }, response_observation: { status: 'active' } };
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation, observationId: 'final-observation' }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'AI_GEO_DOUBAO_SNAPSHOT_READY');
  assert.equal(sent[0].trigger.observation_id, 'final-observation');
  assert.equal(sent[0].observation, observation);
});

test('real browser transport receives an isolated-world Extension trigger and dispatches once', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main>controlled transport fixture</main>');
  const pageRegistry = new PageHandleRegistry();
  const calls = [];
  const bridge = new ObservationSnapshotBridge({
    pageRegistry,
    dispatcher: {
      async captureWithArtifacts({ platform, context }) {
        calls.push({ platform, page: context.page });
        return { snapshot_result: { status: 'captured', artifact_reference: 'doubao.mhtml', bytes: 8, captured_at: '2026-09-15T00:00:00.000Z', error: null }, artifacts: [] };
      }
    }
  });
  const transport = new PlaywrightExtensionObservationTransport();
  bridge.attach(transport);
  await transport.attachPage({ page, session_id: 'session-real', page_id: 'page-real', pageRegistry });
  const triggerSource = await readFile(new URL('../extension/ai-geo-monitor-unified/shared/observation-snapshot-trigger.js', import.meta.url), 'utf8');
  const cdp = await page.context().newCDPSession(page);
  const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'extension-controlled-test' });
  await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: triggerSource });
  const observation = JSON.stringify({
    platform: 'doubao',
    conversation_url: 'https://www.doubao.com/chat/controlled',
    observation_status: 'stable',
    question: { status: 'confirmed' },
    answer: { status: 'confirmed' },
    native_payload: { unchanged: true }
  });
  const expression = `globalThis.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'doubao', observation: ${observation}, observationId: 'controlled-observation' });`;
  await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression });
  await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression });
  await expectEventually(() => calls.length === 1);
  assert.deepEqual(calls, [{ platform: 'doubao', page }]);
});

async function expectEventually(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for the real browser transport.');
}

test('Bridge modules contain no platform DOM logic, DB, GEO backend, or query submission', async () => {
  const source = await readFile(new URL('../src/runtime/playwright/observation-snapshot-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /querySelector|\.locator\(|\.click\(|submitPrompt|repository|database|GEO Delivery/i);
});
