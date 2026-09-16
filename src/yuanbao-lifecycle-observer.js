import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BrowserRuntime } from './core/browser-runtime.js';
import { yuanbaoRuntimeConfig } from './platforms/yuanbao/yuanbao-runtime-config.js';

const RESPONSE_ROOT_SELECTOR = '[data-conv-speaker="ai"]';

export async function readLifecycleObservation(page) {
  const roots = page.locator(RESPONSE_ROOT_SELECTOR);
  const responses = await roots.evaluateAll((nodes) => nodes.map((node, index) => {
    const final = node.querySelector('.hyc-content-md-done');
    // This callback executes in the browser page, so it must not reference
    // Node-side helpers or closures.
    const finalText = String(final?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      index,
      visible: Boolean(node.getClientRects().length),
      outputting: node.getAttribute('data-conv-outputting'),
      finalVisible: Boolean(final?.getClientRects().length),
      finalText,
      finalTextLength: finalText.length
    };
  }));
  return {
    capturedAt: new Date().toISOString(),
    path: await page.evaluate(() => location.pathname),
    responseRootCount: responses.length,
    responses
  };
}

async function main() {
  const observationUrl = process.env.YUANBAO_OBSERVE_URL;
  if (!observationUrl) throw new Error('YUANBAO_OBSERVE_URL is required and is intentionally not stored in source control.');
  const runDir = resolve('artifacts', 'yuanbao-lifecycle-observe', new Date().toISOString().replace(/[:.]/g, '-'));
  const runtime = new BrowserRuntime({ profileDir: resolve('profiles', 'yuanbao'), headless: false, ...yuanbaoRuntimeConfig });
  try {
    await mkdir(runDir, { recursive: true });
    const page = await runtime.newPage();
    await page.goto(observationUrl, { waitUntil: 'domcontentloaded' });
    const startedAt = Date.now();
    const timeline = [];
    while (Date.now() - startedAt < 90_000) {
      timeline.push({ elapsedMs: Date.now() - startedAt, ...await readLifecycleObservation(page) });
      await page.waitForTimeout(500);
    }
    await writeFile(resolve(runDir, 'observation.json'), `${JSON.stringify({ status: 'stable_90_seconds', timeline }, null, 2)}\n`, 'utf8');
    console.log(`Yuanbao lifecycle observer completed 90 seconds without exception; evidence=${runDir}. Browser remains visible; press Ctrl+C to close it.`);
    await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
