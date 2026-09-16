import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ArtifactStore } from './core/artifact-store.js';
import { executeRuntimeNeutralMonitoredRun } from './core/monitored-run.js';
import { openDatabase, GeoRepository } from './db/repository.js';
import { createPlatformRuntime } from './application/platform-runtime-factory.js';

const prompt = { id: 'yuanbao-final-natural-monitoring', text: '今年中国汽车出口主要增长来自哪些市场？', purpose: 'Phase 2 final controlled run' };
const promptSet = { brand: { name: '示例品牌', aliases: ['示例品牌'] }, competitors: [] };
const db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
const repository = new GeoRepository(db);
const artifactStore = new ArtifactStore({ rootDir: resolve('artifacts') });
const platformRuntime = createPlatformRuntime({ platform: 'yuanbao', repository, artifactStore });

async function review(outcome) {
  console.log(JSON.stringify(outcome, null, 2));
  console.log(`Inspect with: npm run db:show -- ${outcome.runId}`);
  const terminal = createInterface({ input, output });
  await terminal.question('人工验收当前可见 Yuanbao 回答后按 Enter 关闭浏览器：');
  terminal.close();
}

try {
  const outcome = await executeRuntimeNeutralMonitoredRun({
    service: platformRuntime.service, platform: platformRuntime.capability.platform, capability: platformRuntime.capability, prompt, promptSet,
    sessionRunner: (input) => platformRuntime.session.run(input),
    closeSession: platformRuntime.closeSession,
    onTerminalPersisted: review
  });
  console.log(JSON.stringify(outcome, null, 2));
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  if (error.runId) console.error(`Recorded failed run: ${error.runId}`);
  process.exitCode = 1;
} finally { db.close(); }
