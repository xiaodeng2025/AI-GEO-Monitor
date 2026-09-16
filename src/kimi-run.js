import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ArtifactStore } from './core/artifact-store.js';
import { loadPromptSet, resolvePromptSetPath } from './core/prompts.js';
import { executeRuntimeNeutralMonitoredRun } from './core/monitored-run.js';
import { openDatabase, GeoRepository } from './db/repository.js';
import { createPlatformRuntime } from './application/platform-runtime-factory.js';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const promptId = option('--prompt');
const timeoutMs = Number(option('--timeout-ms', '90000'));
const manualReview = process.argv.includes('--manual-review');
const promptFile = option('--prompt-file', 'kimi-smoke.json');
if (!promptId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('Usage: npm run kimi:run -- --prompt <prompt-id> [--prompt-file <file-in-prompts>] [--timeout-ms <positive-ms>] [--manual-review]');
  process.exit(1);
}

const promptSet = await loadPromptSet(resolvePromptSetPath(promptFile));
const prompt = promptSet.prompts.find((entry) => entry.id === promptId);
if (!prompt) throw new Error(`Unknown prompt id: ${promptId}`);

const db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
const repository = new GeoRepository(db);
const artifactStore = new ArtifactStore({ rootDir: resolve('artifacts') });
const platformRuntime = createPlatformRuntime({ platform: 'kimi', repository, artifactStore, timeoutMs });

function printRunResult(result) {
  console.log(JSON.stringify(result, null, 2));
  console.log(`Inspect with: npm run db:show -- ${result.runId}`);
}

async function waitForManualReview() {
  console.log('Manual review mode: terminal state and artifacts are saved. The browser remains open for inspection. Do not submit another Prompt, refresh, or click source UI automatically.');
  const terminal = createInterface({ input, output });
  try {
    await new Promise((resolveConfirmation) => {
      let resolved = false;
      const confirm = () => {
        if (!resolved) {
          resolved = true;
          resolveConfirmation();
        }
      };
      terminal.once('SIGINT', () => {
        console.log('Ctrl+C received during manual review; closing the browser without changing the persisted Run.');
        confirm();
      });
      terminal.question('Press Enter after manual page inspection to close the browser: ', confirm);
    });
  } finally {
    terminal.close();
  }
}

try {
  const result = await executeRuntimeNeutralMonitoredRun({
    service: platformRuntime.service,
    platform: platformRuntime.capability.platform, capability: platformRuntime.capability, prompt, promptSet,
    sessionRunner: (input) => platformRuntime.session.run(input),
    closeSession: platformRuntime.closeSession,
    onTerminalPersisted: manualReview
      ? async (terminalResult) => {
        printRunResult(terminalResult);
        await waitForManualReview();
      }
      : null
  });
  if (!manualReview) printRunResult(result);
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  if (error.runId) console.error(`Recorded failed run: ${error.runId}`);
  process.exitCode = 1;
} finally {
  db.close();
}
