import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const extensionRoot = new URL('../extension/ai-geo-monitor-unified/', import.meta.url);
const PREPARE = 'AI_GEO_WENXIN_SNAPSHOT_PREPARE';
const READY = 'AI_GEO_WENXIN_SNAPSHOT_READY';

test('Wenxin Snapshot clicks one source trigger, waits for stable concrete website rows, and preserves native layout', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <button id="sidebar-control"><i class="cos-icon cos-icon-sidebar-right"></i></button><aside id="sidebar">历史</aside>
    <article class="ai-entry"><div class="ai-entry-block ai-markdown"><div class="cosd-markdown-content">完整回答</div></div><button id="source-trigger">共参考 12 篇资料</button><div class="ai-entry-block ai-thinking-steps"><ol id="sources" style="height:60px;max-height:60px;overflow-y:auto"></ol></div></article>`);
  await page.evaluate(() => {
    globalThis.__messages = []; globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
    globalThis.sourceClicks = 0; globalThis.sidebarClicks = 0;
    document.getElementById('sidebar-control').addEventListener('click', () => { globalThis.sidebarClicks += 1; document.getElementById('sidebar').style.display = 'none'; });
    document.getElementById('source-trigger').addEventListener('click', () => {
      globalThis.sourceClicks += 1;
      document.getElementById('sources').innerHTML = '<li data-long-press-ext-info="{&quot;link&quot;:&quot;https://source.example/&quot;,&quot;linkTitle&quot;:&quot;Source&quot;}">真实来源网站</li>';
    });
  });
  const source = await readFile(new URL('platforms/wenxin/extension-snapshot.js', extensionRoot), 'utf8');
  assert.doesNotMatch(source, /scrollTop|style\.setProperty|cloneNode|innerHTML/);
  await page.evaluate(source);
  const result = await sendPageMessage(page, PREPARE);
  assert.equal(result.prepared, true);
  assert.equal(result.sources.facts.rows.length, 1);
  assert.deepEqual(result.sources.facts.rows[0], { text: '真实来源网站', link: 'https://source.example/', linkTitle: 'Source' });
  assert.equal(await page.evaluate(() => globalThis.sourceClicks), 1);
  assert.equal(await page.evaluate(() => globalThis.sidebarClicks), 1);
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  assert.equal(await page.locator('#sources').getAttribute('style'), 'height:60px;max-height:60px;overflow-y:auto');
});

test('Wenxin Snapshot rejects a summary-only source block', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<article class="ai-entry"><div class="ai-entry-block ai-markdown"><div class="cosd-markdown-content">完整回答</div></div><button id="source-trigger">共参考12篇资料</button><div class="ai-entry-block ai-thinking-steps"></div></article>');
  await page.evaluate(() => {
    globalThis.__messages = []; globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
    globalThis.sourceClicks = 0;
    document.getElementById('source-trigger').addEventListener('click', () => { globalThis.sourceClicks += 1; });
  });
  const source = await readFile(new URL('platforms/wenxin/extension-snapshot.js', extensionRoot), 'utf8');
  await page.evaluate(source);
  const result = await sendPageMessage(page, PREPARE);
  assert.match(result.error, /source website rows did not become stable/);
  assert.equal(await page.evaluate(() => globalThis.sourceClicks), 1);
});

test('Wenxin trigger requires a populated current answer and routes only the completed-entry observation', async () => {
  const source = await readFile(new URL('shared/observation-snapshot-trigger.js', extensionRoot), 'utf8');
  const sent = [];
  const context = vm.createContext({ globalThis: null, URL, chrome: { runtime: { sendMessage: (message) => sent.push(message) } } });
  context.globalThis = context; vm.runInContext(source, context);
  const base = { platform: 'wenxin', conversation_url: 'https://wenxin.baidu.com/search/current', observation_state: 'entry_observed', response: { present: true }, final_answer: { status: 'observed', text: '完成回答' } };
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'wenxin', observation: { ...base, final_answer: { status: 'not_observed', text: '' } }, observationId: 'early' }), false);
  assert.equal(context.__AI_GEO_OBSERVATION_SNAPSHOT_TRIGGER__.triggerFor({ platform: 'wenxin', observation: base, observationId: 'final' }), true);
  assert.equal(sent[0].type, READY);
});

test('Wenxin background stores raw MHTML once per conversation and retries after capture failure', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = []; const records = new Map(); let fail = false;
  const context = vm.createContext({ Blob, URL, TextDecoder, TextEncoder, atob, btoa, queueMicrotask, console: { error: () => {} }, chrome: {
    runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
    tabs: { sendMessage: async (_tabId, message) => { assert.equal(message.type, PREPARE); return { prepared: true }; } },
    pageCapture: { saveAsMHTML: async () => { if (fail) throw new Error('capture failed'); return new Blob(['W-MHTML'], { type: 'application/x-mimearchive' }); } },
    storage: { session: { set: async () => {}, get: async () => ({}) } }
  }, indexedDB: fakeIndexedDb(records) });
  vm.runInContext(source, context);
  const message = (id, suffix = 'current') => ({ type: READY, trigger: { platform: 'wenxin', conversation_url: `https://wenxin.baidu.com/search/${suffix}`, observation_id: id } });
  assert.equal((await dispatch(listeners[0], message('A'))).status, 'captured');
  assert.equal((await dispatch(listeners[0], message('B'))).status, 'deduped');
  const record = [...records.values()][0];
  assert.match(record.filename, /^wenxin-snapshot-.*\.mhtml$/); assert.equal(await record.blob.text(), 'W-MHTML');
  fail = true; assert.equal((await dispatch(listeners[0], message('C', 'retry'))).status, 'failed');
  fail = false; assert.equal((await dispatch(listeners[0], message('D', 'retry'))).status, 'captured');
});

test('Wenxin manifest loads snapshot preparation before its observation content', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.matches.includes('https://wenxin.baidu.com/*') && entry.js.includes('platforms/wenxin/content.js')).js;
  assert.equal(scripts.indexOf('platforms/wenxin/extension-snapshot.js') < scripts.indexOf('platforms/wenxin/content.js'), true);
});

async function sendPageMessage(page, type) { return page.evaluate((messageType) => new Promise((resolve) => globalThis.__messages[0]({ type: messageType }, {}, resolve)), type); }
async function dispatch(listener, message) { return new Promise((resolve) => assert.equal(listener(message, { tab: { id: 8 } }, resolve), true)); }
function fakeIndexedDb(records) { return { open() { const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }; request.result = { objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {}, transaction: () => { const transaction = { error: null, oncomplete: null, onerror: null, onabort: null }; transaction.objectStore = () => ({ put(record) { const put = { error: null, onerror: null }; queueMicrotask(() => { records.set(record.snapshot_id, record); transaction.oncomplete?.(); }); return put; } }); return transaction; } }; queueMicrotask(() => request.onsuccess?.()); return request; } }; }
