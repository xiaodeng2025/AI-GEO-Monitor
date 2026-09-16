import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ArtifactStore } from './core/artifact-store.js';
import { loadPromptSet, resolvePromptSetPath } from './core/prompts.js';
import { executeRuntimeNeutralMonitoredRun } from './core/monitored-run.js';
import { openDatabase, GeoRepository } from './db/repository.js';
import { createPlatformRuntime } from './application/platform-runtime-factory.js';

function option(name, fallback = null) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
const promptId = option('--prompt');
const timeoutMs = Number(option('--timeout-ms', '90000'));
const promptFile = option('--prompt-file', 'deepseek-natural.json');
const manualReview = process.argv.includes('--manual-review');
if (!promptId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('Usage: npm run deepseek:run -- --prompt <prompt-id> [--prompt-file <file>] [--timeout-ms <positive-ms>] [--manual-review]');
  process.exit(1);
}
const promptSet = await loadPromptSet(resolvePromptSetPath(promptFile));
const prompt = promptSet.prompts.find((entry) => entry.id === promptId);
if (!prompt) throw new Error(`Unknown prompt id: ${promptId}`);
const db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
const repository = new GeoRepository(db);
const artifactStore = new ArtifactStore({ rootDir: resolve('artifacts') });
const platformRuntime = createPlatformRuntime({ platform: 'deepseek', repository, artifactStore, timeoutMs });
async function review() {
  console.log('Manual review: browser remains open. Do not submit another Prompt or click source UI automatically.');
  const terminal = createInterface({ input, output });
  try { await terminal.question('Press Enter after manual page inspection to close the browser: '); } finally { terminal.close(); }
}
try {
  const result = await executeRuntimeNeutralMonitoredRun({
    service: platformRuntime.service, platform: platformRuntime.capability.platform, capability: platformRuntime.capability, prompt, promptSet,
    sessionRunner: (input) => platformRuntime.session.run(input),
    closeSession: platformRuntime.closeSession,
    onTerminalPersisted: manualReview ? review : null
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  if (error.runId) console.error(`Recorded failed run: ${error.runId}`);
  process.exitCode = 1;
} finally { db.close(); }
