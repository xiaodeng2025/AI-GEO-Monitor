import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { ArtifactStore } from './core/artifact-store.js';
import { ObservationSnapshotBridge, PageHandleRegistry } from './runtime/playwright/observation-snapshot-bridge.js';
import { PlaywrightExtensionObservationTransport } from './runtime/playwright/playwright-extension-observation-transport.js';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = option('--url');
if (!url) throw new Error('Usage: node src/extension-observation-snapshot-manual.js --url <https URL>');

const profileDir = resolve('runtime-data', 'browser-profile');
const extensionDir = resolve('extension', 'ai-geo-monitor-unified');
const session_id = `extension-session-${randomUUID()}`;
const page_id = `extension-page-${randomUUID()}`;
const runId = `extension-observation-${randomUUID()}`;
const pageRegistry = new PageHandleRegistry();
const bridge = new ObservationSnapshotBridge({ pageRegistry });
const transport = new PlaywrightExtensionObservationTransport();
const artifactStore = new ArtifactStore({ rootDir: resolve('artifacts') });

let resolveOutcome;
const outcomeReady = new Promise((resolve) => { resolveOutcome = resolve; });
transport.subscribe(async (envelope) => {
  const outcome = await bridge.receive(envelope);
  const payloads = [
    ...outcome.artifacts,
    { kind: 'extension_observation', fileName: 'observation.json', content: `${JSON.stringify(outcome.observation, null, 2)}\n` },
    { kind: 'snapshot_result', fileName: 'snapshot-result.json', content: `${JSON.stringify(outcome.snapshot_result, null, 2)}\n` }
  ];
  const artifacts = await artifactStore.persistMaterialized(runId, payloads);
  resolveOutcome({ ...outcome, artifacts });
});

await mkdir(profileDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge', headless: false, viewport: null, ignoreDefaultArgs: ['--no-sandbox'],
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
});
const page = context.pages()[0] || await context.newPage();
try {
  await transport.attachPage({ page, session_id, page_id, pageRegistry });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log(JSON.stringify({ event: 'extension_observation_snapshot_ready', initial_url: page.url(), session_id, page_id }));
  console.log('Submit one normal Query manually in the visible browser. This runner contains no Query automation.');
  const outcome = await Promise.race([
    outcomeReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for an Extension observation snapshot trigger.')), 10 * 60 * 1000))
  ]);
  console.log(JSON.stringify({ event: 'snapshot_completed', conversation_url: outcome.observation?.conversation_url ?? null, snapshot_result: outcome.snapshot_result, artifacts: outcome.artifacts }, null, 2));
} finally {
  await context.close();
}
