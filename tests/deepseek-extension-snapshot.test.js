import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const extensionRoot = new URL('../extension/ai-geo-monitor-unified/', import.meta.url);
const PREPARE = 'AI_GEO_DEEPSEEK_SNAPSHOT_PREPARE';
const FREEZE = 'AI_GEO_DEEPSEEK_SNAPSHOT_FREEZE';

test('DeepSeek preparation expands sources once, and frozen HTML releases only actual scrolling paths', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <link rel="stylesheet" href="https://assets.example/snapshot.css"><img src="https://assets.example/source.png"><div class="e066abb8"></div><div class="_23e1c55"><button role="button">first</button><button id="collapse" role="button">collapse</button></div>
    <aside id="sidebar"><span>开启新对话</span><span>今天</span></aside>
    <main><article class="ds-message"><p>问题</p></article><article><div id="answer-scroll" class="ds-scroll-area" style="height:20px;overflow-y:auto"><div class="ds-markdown ds-assistant-message-main-content" style="height:200px">回答 <a href="https://citation.example">[1]</a></div></div></article></main>
    <button id="sources">搜索到 1 个网页</button><section id="panel" style="display:none"><h2 role="heading">搜索结果</h2><div id="source-scroll" class="ds-scroll-area" style="height:auto;overflow-y:visible"><a href="https://one.example">一</a></div></section>
    <script>window.bad = true</script>`);
  await page.evaluate(() => {
    globalThis.__messages = []; globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
    globalThis.sourceClicks = 0;
    document.getElementById('collapse').addEventListener('click', () => { document.getElementById('sidebar').style.display = 'none'; });
    document.getElementById('sources').addEventListener('click', () => { globalThis.sourceClicks += 1; document.getElementById('panel').style.display = 'block'; });
  });
  const source = await readFile(new URL('platforms/deepseek/extension-snapshot.js', extensionRoot), 'utf8');
  assert.doesNotMatch(source, /scrollTop/);
  await page.evaluate(source);
  const prepare = await message(page, PREPARE);
  assert.deepEqual(prepare, { prepared: true, expected: 1 });
  const frozen = await message(page, FREEZE, { expected: prepare.expected, resources: [
    { keys: ['https://assets.example/snapshot.css'], text: '@font-face{src:url(https://assets.example/font.woff)} .offline{background:url(https://assets.example/source.png)}', data_url: 'data:text/css;base64,Lm9mZmxpbmV7fQ==' },
    { keys: ['https://assets.example/source.png'], data_url: 'data:image/png;base64,AA==' }
  ] });
  assert.equal(frozen.prepared, true);
  assert.match(frozen.artifact_html, /回答/);
  assert.match(frozen.artifact_html, /data-original-href="https:\/\/one\.example\//);
  assert.doesNotMatch(frozen.artifact_html, /<script\b/i);
  assert.doesNotMatch(frozen.artifact_html, /<iframe\b/i);
  assert.match(frozen.artifact_html, /data-dead-snapshot-stylesheet/);
  assert.match(frozen.artifact_html, /data:image\/png;base64,AA==/);
  assert.doesNotMatch(frozen.artifact_html, /@font-face/i);
  assert.match(frozen.artifact_html, /answer-scroll[^>]*max-height: none/i);
  assert.doesNotMatch(frozen.artifact_html, /source-scroll[^>]*max-height: none/i);
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  assert.equal(await page.locator('#panel').isVisible(), true);
  assert.equal(await page.evaluate(() => globalThis.sourceClicks), 1);
});

test('DeepSeek preparation waits for actual source content and does not fail without a source entry point', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const source = await readFile(new URL('platforms/deepseek/extension-snapshot.js', extensionRoot), 'utf8');
  const delayed = await browser.newPage();
  await delayed.setContent('<button id="sources">搜索到 1 个网页</button><section id="panel" style="display:none"><h2 role="heading">搜索结果</h2></section>');
  await install(delayed, source, () => document.getElementById('sources').addEventListener('click', () => {
    document.getElementById('panel').style.display = 'block';
    setTimeout(() => document.getElementById('panel').insertAdjacentHTML('beforeend', '<a href="https://source.example">来源</a>'), 150);
  }));
  const pending = message(delayed, PREPARE);
  await delayed.waitForTimeout(50);
  assert.equal(await delayed.locator('#panel a').count(), 0);
  assert.deepEqual(await pending, { prepared: true, expected: 1 });
  const noSources = await browser.newPage();
  await noSources.setContent('<main class="ds-markdown ds-assistant-message-main-content">回答</main>');
  await install(noSources, source);
  assert.deepEqual(await message(noSources, PREPARE), { prepared: true, expected: 0 });
});

test('DeepSeek background uses MHTML only as a resource carrier, then stores frozen HTML once per conversation', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = []; const calls = []; const records = new Map(); const freezeHtml = deepSeekHtml();
  const context = backgroundContext({ listeners, calls, records, sendMessage: async (_tabId, message) => {
    calls.push(message.type);
    if (message.type === PREPARE) return { prepared: true, expected: 1 };
    assert.equal(message.type, FREEZE); assert.equal(message.resources.length, 1);
    return { prepared: true, artifact_html: freezeHtml };
  } });
  vm.runInContext(source, context);
  const send = (observationId) => dispatch(listeners[0], readyMessage(observationId, 'current'));
  assert.equal((await send('A')).status, 'captured');
  assert.equal((await send('B')).status, 'deduped');
  assert.deepEqual(calls, [PREPARE, 'mhtml', FREEZE]);
  assert.equal(records.size, 1);
  const record = [...records.values()][0];
  assert.deepEqual({ platform: record.platform, observation_id: record.observation_id, mime_type: record.mime_type }, { platform: 'deepseek', observation_id: 'A', mime_type: 'text/html' });
  assert.match(record.filename, /^deepseek-dead-snapshot-v3-.*\.html$/);
  assert.equal(await record.blob.text(), freezeHtml);
});

test('DeepSeek background blocks changed observations while in-flight and permits retry after capture failure', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = []; const calls = []; const records = new Map(); let release; let started; let shouldFail = false; let delayedPrepare = true;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const context = backgroundContext({ listeners, calls, records, sendMessage: async (_tabId, message) => {
    calls.push(message.type);
    if (message.type === PREPARE) {
      if (!delayedPrepare) return { prepared: true, expected: 1 };
      delayedPrepare = false; started(); return new Promise((resolve) => { release = resolve; });
    }
    if (shouldFail) return { error: 'freeze failed' };
    return { prepared: true, artifact_html: deepSeekHtml() };
  } });
  vm.runInContext(source, context);
  const first = dispatch(listeners[0], readyMessage('A', 'retry'));
  await startedPromise;
  assert.equal((await dispatch(listeners[0], readyMessage('B', 'retry'))).status, 'deduped');
  release({ prepared: true, expected: 1 });
  assert.equal((await first).status, 'captured');
  assert.equal(records.size, 1);
  shouldFail = true;
  const failed = await dispatch(listeners[0], readyMessage('C', 'failed-retry'));
  assert.equal(failed.status, 'failed');
  shouldFail = false;
  assert.equal((await dispatch(listeners[0], readyMessage('D', 'failed-retry'))).status, 'captured');
});

test('DeepSeek stable observation is sent through the Extension runtime message unchanged', async () => {
  const source = await readFile(new URL('shared/observation-snapshot-trigger.js', extensionRoot), 'utf8');
  const sent = [];
  const context = vm.createContext({ globalThis: null, URL, chrome: { runtime: { sendMessage: (message) => sent.push(message) } } });
  context.globalThis = context; vm.runInContext(source, context);
  const observation = { platform: 'deepseek', conversation_url: 'https://chat.deepseek.com/a/chat/s/final', answer: '完整回答' };
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'deepseek', observation, observationId: 'stable-A' }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: 'AI_GEO_DEEPSEEK_SNAPSHOT_READY', trigger: { type: 'observation_snapshot_ready', platform: 'deepseek', observation_id: 'stable-A', session_id: null, page_id: null, conversation_url: 'https://chat.deepseek.com/a/chat/s/final', readiness: 'observation_ready' }, observation });
});

test('DeepSeek manifest loads the page preparation before its observation content script', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.matches.includes('https://chat.deepseek.com/*')).js;
  assert.equal(scripts.indexOf('platforms/deepseek/extension-snapshot.js') < scripts.indexOf('platforms/deepseek/content.js'), true);
});

async function install(page, source, setup = null) {
  await page.evaluate((setupText) => {
    globalThis.__messages = []; globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
    if (setupText) globalThis.eval(`(${setupText})`)();
  }, setup?.toString() || null);
  await page.evaluate(source);
}
async function message(page, type, payload = {}) { return page.evaluate(({ type, payload }) => new Promise((resolve) => globalThis.__messages[0]({ type, ...payload }, {}, resolve)), { type, payload }); }
function readyMessage(observationId, suffix) { return { type: 'AI_GEO_DEEPSEEK_SNAPSHOT_READY', trigger: { platform: 'deepseek', conversation_url: `https://chat.deepseek.com/a/chat/s/${suffix}`, observation_id: observationId }, observation: { unchanged: true } }; }
function deepSeekHtml() { return '<!DOCTYPE html><html><body><aside>来源</aside><a data-original-href="https://source.example/" aria-disabled="true">来源</a></body></html>'; }
function mhtml() { return 'Content-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Location: https://chat.deepseek.com/style.css\r\nContent-Type: text/css\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n.a{color:red}\r\n--b--'; }
function backgroundContext({ listeners, calls, records, sendMessage }) {
  return vm.createContext({ Blob, URL, TextDecoder, TextEncoder, atob, btoa, queueMicrotask, console: { error: () => {} }, chrome: {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
    tabs: { sendMessage: async (...args) => sendMessage(...args) },
    pageCapture: { saveAsMHTML: async () => { calls.push('mhtml'); return new Blob([mhtml()]); } },
    storage: { session: { set: async () => {}, get: async () => ({}) } }
  }, indexedDB: fakeIndexedDb(records) });
}
async function dispatch(listener, message) { return new Promise((resolve) => assert.equal(listener(message, { tab: { id: 3 } }, resolve), true)); }
function fakeIndexedDb(records) { return { open() { const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }; request.result = { objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {}, transaction: () => { const transaction = { error: null, oncomplete: null, onerror: null, onabort: null }; transaction.objectStore = () => ({ put(record) { const put = { error: null, onerror: null }; queueMicrotask(() => { records.set(record.snapshot_id, record); transaction.oncomplete?.(); }); return put; } }); return transaction; } }; queueMicrotask(() => request.onsuccess?.()); return request; } }; }
