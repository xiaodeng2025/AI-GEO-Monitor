import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const extensionRoot = new URL('../extension/ai-geo-monitor-unified/', import.meta.url);
const PREPARE = 'AI_GEO_YUANBAO_SNAPSHOT_PREPARE';
const READY = 'AI_GEO_YUANBAO_SNAPSHOT_READY';

test('Yuanbao Snapshot uses the bottom citation control, waits for two stable panel facts, and leaves native scroll styling alone', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button aria-label="收起侧栏" id="sidebar-control">收起</button><aside id="sidebar">新对话</aside>
    <button id="handled">已处理</button><button id="search-guide-tool" data-toolbar-type="citation">引用</button>
    <section id="chatReferenceList" class="agent-dialogue-references" style="display:none"><h2>引用来源（2）</h2><div id="source-scroll" style="height:60px;max-height:60px;overflow-y:auto">来源一 来源二</div></section>`);
  await page.evaluate(() => {
    globalThis.__messages = []; globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
    globalThis.citationClicks = 0; globalThis.handledClicks = 0;
    document.getElementById('sidebar-control').addEventListener('click', () => { document.getElementById('sidebar').style.display = 'none'; });
    document.getElementById('search-guide-tool').addEventListener('click', () => { globalThis.citationClicks += 1; document.getElementById('chatReferenceList').style.display = 'block'; });
    document.getElementById('handled').addEventListener('click', () => { globalThis.handledClicks += 1; });
  });
  const source = await readFile(new URL('platforms/yuanbao/extension-snapshot.js', extensionRoot), 'utf8');
  assert.doesNotMatch(source, /scrollTop|style\.setProperty|cloneNode|innerHTML/);
  await page.evaluate(source);
  const result = await sendPageMessage(page, PREPARE);
  assert.equal(result.prepared, true, JSON.stringify(result));
  assert.equal(result.sidebar.status, 'collapsed');
  assert.equal(result.sources.status, 'expanded');
  assert.equal(result.sources.facts.sourcePanelCount, 2);
  assert.equal(await page.evaluate(() => globalThis.citationClicks), 1);
  assert.equal(await page.evaluate(() => globalThis.handledClicks), 0);
  assert.equal(await page.locator('#source-scroll').getAttribute('style'), 'height:60px;max-height:60px;overflow-y:auto');
});

test('Yuanbao trigger requires a completed current response and sends the Yuanbao background message unchanged', async () => {
  const source = await readFile(new URL('shared/observation-snapshot-trigger.js', extensionRoot), 'utf8');
  const sent = [];
  const context = vm.createContext({ globalThis: null, URL, chrome: { runtime: { sendMessage: (message) => sent.push(message) } } });
  context.globalThis = context; vm.runInContext(source, context);
  const base = { platform: 'yuanbao', conversation_url: 'https://yuanbao.tencent.com/chat/first/second', observation_state: 'expansion_complete', response: { attributes: { 'data-conv-outputting': 'false' } } };
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'yuanbao', observation: { ...base, observation_state: 'raw_acquisition_only' }, observationId: 'early' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'yuanbao', observation: base, observationId: 'final' }), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: READY, trigger: { type: 'observation_snapshot_ready', platform: 'yuanbao', observation_id: 'final', session_id: null, page_id: null, conversation_url: base.conversation_url, readiness: 'observation_ready' }, observation: base });
});

test('Yuanbao background stores one raw MHTML per conversation and permits retry after failure', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = []; const records = new Map(); const calls = []; let captureFails = false;
  const context = vm.createContext({ Blob, URL, TextDecoder, TextEncoder, atob, btoa, queueMicrotask, console: { error: () => {} }, chrome: {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
    tabs: { sendMessage: async (_tabId, message) => { calls.push(message.type); return { prepared: true }; } },
    pageCapture: { saveAsMHTML: async () => { calls.push('mhtml'); if (captureFails) throw new Error('capture failed'); return new Blob(['Y-MHTML'], { type: 'application/x-mimearchive' }); } },
    storage: { session: { set: async () => {}, get: async () => ({}) } }
  }, indexedDB: fakeIndexedDb(records) });
  vm.runInContext(source, context);
  const message = (id, suffix = 'current') => ({ type: READY, trigger: { platform: 'yuanbao', conversation_url: `https://yuanbao.tencent.com/chat/first/${suffix}`, observation_id: id } });
  assert.equal((await dispatch(listeners[0], message('A'))).status, 'captured');
  assert.equal((await dispatch(listeners[0], message('B'))).status, 'deduped');
  assert.deepEqual(calls, [PREPARE, 'mhtml']);
  const record = [...records.values()][0];
  assert.equal(record.platform, 'yuanbao'); assert.match(record.filename, /^yuanbao-snapshot-.*\.mhtml$/); assert.equal(record.mime_type, 'application/x-mimearchive'); assert.equal(await record.blob.text(), 'Y-MHTML');
  captureFails = true;
  assert.equal((await dispatch(listeners[0], message('C', 'retry'))).status, 'failed');
  captureFails = false;
  assert.equal((await dispatch(listeners[0], message('D', 'retry'))).status, 'captured');
});

test('Yuanbao manifest loads its snapshot preparation before observation content', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.matches.includes('https://yuanbao.tencent.com/*') && entry.js.includes('platforms/yuanbao/content.js')).js;
  assert.equal(scripts.indexOf('platforms/yuanbao/extension-snapshot.js') < scripts.indexOf('platforms/yuanbao/content.js'), true);
});

async function sendPageMessage(page, type) { return page.evaluate((messageType) => new Promise((resolve) => globalThis.__messages[0]({ type: messageType }, {}, resolve)), type); }
async function dispatch(listener, message) { return new Promise((resolve) => assert.equal(listener(message, { tab: { id: 5 } }, resolve), true)); }
function fakeIndexedDb(records) { return { open() { const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }; request.result = { objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {}, transaction: () => { const transaction = { error: null, oncomplete: null, onerror: null, onabort: null }; transaction.objectStore = () => ({ put(record) { const put = { error: null, onerror: null }; queueMicrotask(() => { records.set(record.snapshot_id, record); transaction.oncomplete?.(); }); return put; } }); return transaction; } }; queueMicrotask(() => request.onsuccess?.()); return request; } }; }
