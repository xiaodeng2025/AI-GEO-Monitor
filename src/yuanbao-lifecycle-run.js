import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserRuntime } from './core/browser-runtime.js';
import { fingerprint } from './core/hash.js';
import { YuanbaoResponseDom } from './platforms/yuanbao/yuanbao-response-dom.js';
import { yuanbaoRuntimeConfig } from './platforms/yuanbao/yuanbao-runtime-config.js';
import { readLifecycleObservation } from './yuanbao-lifecycle-observer.js';

const prompt = '今年中国汽车出口主要增长来自哪些市场？';
const runDir = resolve('artifacts', 'yuanbao-lifecycle-run', new Date().toISOString().replace(/[:.]/g, '-'));
const runtime = new BrowserRuntime({ profileDir: resolve('profiles', 'yuanbao'), headless: false, ...yuanbaoRuntimeConfig });

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function writeJson(name, value) {
  await writeFile(resolve(runDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function newChatSummary(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const item = [...document.querySelectorAll('*')].find((node) => normalize(node.innerText) === '新对话' && ![...node.children].some((child) => normalize(child.innerText) === '新对话'));
    if (!item || !item.getClientRects().length) return null;
    const target = item.closest('button, [role="button"], a, [onclick]') || item;
    return {
      element: { tag: item.tagName.toLowerCase(), classNames: [...item.classList] },
      target: { tag: target.tagName.toLowerCase(), classNames: [...target.classList], attributes: Object.fromEntries([...target.attributes].map((attribute) => [attribute.name, attribute.value])) }
    };
  });
}

async function activateNewChat(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const item = [...document.querySelectorAll('*')].find((node) => normalize(node.innerText) === '新对话' && ![...node.children].some((child) => normalize(child.innerText) === '新对话'));
    if (!item || !item.getClientRects().length) return false;
    (item.closest('button, [role="button"], a, [onclick]') || item).click();
    return true;
  });
}

async function waitForCompletedLifecycle(page, startedAt, preSubmitObservation) {
  const timeline = [{ phase: 'pre-submit', elapsedMs: 0, ...preSubmitObservation }];
  const first = { response: null, outputtingTrue: null, outputtingFalse: null, finalNonEmpty: null, finalStable: null, citationNonEmpty: null, citationStable: null };
  let finalFingerprint = null;
  let finalChangedAt = null;
  let triggerFingerprint = null;
  let triggerChangedAt = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const observation = await readLifecycleObservation(page);
    const latest = observation.responses.at(-1) ?? null;
    const elapsedMs = Date.now() - startedAt;
    const state = { phase: 'post-submit', elapsedMs, path: observation.path, responseRootCount: observation.responseRootCount, latest };
    timeline.push(state);
    if (latest) {
      first.response ??= elapsedMs;
      if (latest.outputting === 'true') first.outputtingTrue ??= elapsedMs;
      if (latest.outputting === 'false') first.outputtingFalse ??= elapsedMs;
      if (latest.finalText) first.finalNonEmpty ??= elapsedMs;
      const currentFinalFingerprint = latest.finalText ? fingerprint(latest.finalText) : null;
      if (currentFinalFingerprint !== finalFingerprint) {
        finalFingerprint = currentFinalFingerprint;
        finalChangedAt = currentFinalFingerprint ? elapsedMs : null;
      }
      const currentTriggerFingerprint = JSON.stringify(latest.triggerIndexes ?? []);
      if (currentTriggerFingerprint !== triggerFingerprint) {
        triggerFingerprint = currentTriggerFingerprint;
        triggerChangedAt = elapsedMs;
      }
      if (latest.triggerIndexes?.length) first.citationNonEmpty ??= elapsedMs;
      if (latest.outputting === 'false' && latest.finalVisible && latest.finalText && finalChangedAt !== null && elapsedMs - finalChangedAt >= 1_000) {
        first.finalStable ??= elapsedMs;
        if (!latest.triggerIndexes?.length || elapsedMs - triggerChangedAt >= 1_000) first.citationStable ??= elapsedMs;
        if (elapsedMs - first.finalStable >= 1_500) return { status: 'completed', first, timeline };
      }
    }
    await page.waitForTimeout(250);
  }
  return { status: 'timeout', first, timeline };
}

let page = null;
let submitted = false;
try {
  await mkdir(runDir, { recursive: true });
  page = await runtime.newPage();
  await page.goto('https://yuanbao.tencent.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
  const newChat = await newChatSummary(page);
  if (!newChat || !await activateNewChat(page)) throw new Error('Fresh-chat control was not available. No Prompt was submitted.');
  await page.waitForTimeout(800);
  const baseline = await readLifecycleObservation(page);
  const editor = page.locator('.ql-editor[contenteditable="true"]').first();
  const fresh = { newChat, path: baseline.path, assistantBaseline: baseline.responseRootCount, editorVisible: await editor.isVisible(), editorText: cleanText(await editor.innerText()) };
  await writeJson('fresh-chat.json', fresh);
  if (fresh.assistantBaseline !== 0 || !fresh.editorVisible || fresh.editorText) throw new Error('Fresh-chat gates failed. No Prompt was submitted.');
  await editor.click();
  await page.keyboard.insertText(prompt);
  const entered = cleanText(await editor.innerText());
  await writeJson('prompt.json', { prompt, entered, matches: entered === prompt });
  if (entered !== prompt) throw new Error('Prompt text mismatch. No Prompt was submitted.');
  const send = page.locator('[aria-label="发送"]').first();
  if (!await send.isVisible()) throw new Error('Visible send control was not found. No Prompt was submitted.');
  await send.click();
  submitted = true;
  const submittedAt = Date.now();
  await writeJson('submission.json', { prompt, submittedAt: new Date(submittedAt).toISOString() });
  const lifecycle = await waitForCompletedLifecycle(page, submittedAt, baseline);
  await writeJson('lifecycle.json', lifecycle);
  const completedRoot = page.locator('[data-conv-speaker="ai"][data-conv-outputting="false"]').last();
  const dom = new YuanbaoResponseDom(page);
  const completed = lifecycle.status === 'completed' && await dom.isCompleted(completedRoot);
  const final = completedRoot.locator('.hyc-content-md-done').last();
  const finalText = completed ? cleanText(await final.innerText()) : '';
  let citations = { status: 'not_attempted', citations: [] };
  let platformReportedSourceCount = null;
  if (completed) {
    await writeFile(resolve(runDir, 'response-root.html'), await completedRoot.evaluate((node) => node.outerHTML), 'utf8');
    await writeFile(resolve(runDir, 'final-answer.html'), await final.evaluate((node) => node.outerHTML), 'utf8');
    await final.screenshot({ path: resolve(runDir, 'final-answer.png') });
    const sourceLabel = await completedRoot.locator('#search-guide-tool[data-toolbar-type="citation"]').getAttribute('aria-label');
    platformReportedSourceCount = Number(sourceLabel?.match(/(\d+)篇/)?.[1] ?? '') || null;
    try {
      citations = await dom.extractCitations(completedRoot);
    } catch (error) {
      citations = { status: 'parse_failed', citations: [], error: `${error.name}: ${error.message}` };
    }
  }
  const uniqueSources = [...new Set(citations.citations.map((citation) => citation.source_index))].length;
  await writeJson('citation.json', { status: citations.status, occurrences: citations.citations.length, uniqueSources, platformReportedSourceCount, citations: citations.citations, error: citations.error ?? null });
  await writeJson('run-status.json', { status: lifecycle.status, fresh, lifecycle: lifecycle.first, finalTextLength: finalText.length, citationStatus: citations.status, citationOccurrences: citations.citations.length, uniqueSources, platformReportedSourceCount });
  console.log(`Yuanbao lifecycle status=${lifecycle.status}; evidence=${runDir}. Browser remains visible; press Ctrl+C to close it.`);
  await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
} catch (error) {
  await writeJson('failure.json', { submitted, name: error.name, message: error.message, at: new Date().toISOString() }).catch(() => {});
  console.error(`${error.name}: ${error.message}`);
  if (submitted && page) await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
