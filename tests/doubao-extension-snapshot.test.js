import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const extensionRoot = new URL('../extension/ai-geo-monitor-unified/', import.meta.url);

test('Doubao Extension V4 preparation restores the live page after capture preparation', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent('<div class="main-with-nav-qLRcbu"><aside class="container-hzjmF1">sidebar</aside><main><article>answer <a href="https://citation.example">[1]</a></article></main></div><div style="position:fixed;bottom:0;height:140px"><div contenteditable="true">composer</div><button>send</button></div><script>window.extensionSnapshotFixture = true</script>');
  await page.evaluate(() => {
    globalThis.__messages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
  });
  const source = await readFile(new URL('platforms/doubao/extension-snapshot.js', extensionRoot), 'utf8');
  await page.evaluate(source);
  const before = await page.evaluate(() => ({ sidebar: Boolean(document.querySelector('.container-hzjmF1')), composer: Boolean(document.querySelector('[contenteditable="true"]')), href: document.querySelector('a')?.getAttribute('href'), script: Boolean(document.querySelector('script')) }));
  const prepared = await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'fixture' });
  const during = await page.evaluate(() => ({ sidebar: Boolean(document.querySelector('.container-hzjmF1')), composer: Boolean(document.querySelector('[contenteditable="true"]')), hrefs: document.querySelectorAll('a[href]').length, originalHrefs: document.querySelectorAll('a[data-original-href]').length, scripts: document.scripts.length }));
  const restored = await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE', snapshot_id: 'fixture' });
  const after = await page.evaluate(() => ({ sidebar: Boolean(document.querySelector('.container-hzjmF1')), composer: Boolean(document.querySelector('[contenteditable="true"]')), href: document.querySelector('a')?.getAttribute('href'), script: Boolean(document.querySelector('script')) }));
  assert.deepEqual(prepared, { prepared: true });
  assert.deepEqual(during, { sidebar: false, composer: false, hrefs: 0, originalHrefs: 1, scripts: 0 });
  assert.deepEqual(restored, { restored: true });
  assert.deepEqual(after, before);
});

test('Doubao Extension Snapshot clicks the native reference websites entry once even when source content is already visible', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await snapshotPage(browser, true);
  const prepared = await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'already-expanded' });
  assert.deepEqual(prepared, { prepared: true });
  assert.equal(await page.evaluate(() => globalThis.referenceClicks), 1);
  assert.equal(await page.locator('#references').isVisible(), true);
  assert.deepEqual(await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE', snapshot_id: 'already-expanded' }), { restored: true });
  assert.equal(await page.locator('#references').isVisible(), true);
});

test('Doubao Extension Snapshot expands native reference websites once and keeps them open after capture', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await snapshotPage(browser, false, { collapsesWhenControlIsRestored: true });
  const prepared = await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'temporarily-expanded' });
  assert.deepEqual(prepared, { prepared: true });
  assert.equal(await page.evaluate(() => globalThis.referenceClicks), 1);
  assert.equal(await page.locator('#reference-control').isDisabled(), false);
  assert.equal(await page.locator('#references').isVisible(), true);
  assert.deepEqual(await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE', snapshot_id: 'temporarily-expanded' }), { restored: true });
  assert.equal(await page.evaluate(() => globalThis.referenceClicks), 1);
  assert.equal(await page.locator('#references').isVisible(), true);
});

test('Doubao Extension Snapshot captures normally without a reference websites entry', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent('<div class="main-with-nav-qLRcbu"><aside class="container-hzjmF1">sidebar</aside><main><button id="unrelated">unrelated</button><article>answer</article></main></div><div style="position:fixed;bottom:0;height:140px"><div contenteditable="true">composer</div><button>send</button></div>');
  await page.evaluate(() => {
    globalThis.unrelatedClicks = 0;
    document.getElementById('unrelated').addEventListener('click', () => { globalThis.unrelatedClicks += 1; });
    globalThis.__messages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
  });
  const source = await readFile(new URL('platforms/doubao/extension-snapshot.js', extensionRoot), 'utf8');
  await page.evaluate(source);
  assert.deepEqual(await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'no-references' }), { prepared: true });
  assert.equal(await page.evaluate(() => globalThis.unrelatedClicks), 0);
});

test('Doubao Extension Snapshot accepts visible source cards when Doubao does not update the toggle ARIA state', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent('<div class="main-with-nav-qLRcbu"><aside class="container-hzjmF1">sidebar</aside><main><section data-plugin-identifier="search_query_result_block"><div id="reference-control" role="button" aria-expanded="false">搜索 2 个关键词，参考 2 篇资料</div><div id="source-cards" style="display:none"><div>真实来源网站</div></div></section><article>answer</article></main></div><div style="position:fixed;bottom:0;height:140px"><div contenteditable="true">composer</div><button>send</button></div>');
  await page.evaluate(() => {
    globalThis.referenceClicks = 0;
    const control = document.getElementById('reference-control');
    control.addEventListener('click', () => { globalThis.referenceClicks += 1; document.getElementById('source-cards').style.display = 'block'; });
    globalThis.__messages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
  });
  const source = await readFile(new URL('platforms/doubao/extension-snapshot.js', extensionRoot), 'utf8');
  await page.evaluate(source);
  assert.deepEqual(await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'visible-cards' }), { prepared: true });
  assert.equal(await page.evaluate(() => globalThis.referenceClicks), 1);
  assert.equal(await page.locator('#source-cards').isVisible(), true);
});

test('Doubao Extension Snapshot fails before capture when a native reference websites section cannot expand', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await snapshotPage(browser, false, { respondsToClick: false });
  const prepared = await message(page, { type: 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE', snapshot_id: 'expand-failure' });
  assert.match(prepared.error, /reference websites did not expand/);
  assert.equal(await page.locator('.container-hzjmF1').isVisible(), true);
  assert.equal(await page.locator('[contenteditable="true"]').isVisible(), true);
});

test('Doubao Extension background stores one silent MHTML per completed conversation and isolates failure', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = [];
  const calls = [];
  const records = new Map();
  let storedDebug = null;
  const context = vm.createContext({
    Blob,
    URL,
    queueMicrotask,
    console: { error: () => {} },
    chrome: {
      runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
      tabs: { sendMessage: async (_tabId, message) => { calls.push(message.type); return message.type.endsWith('PREPARE') ? { prepared: true } : { restored: true }; } },
      pageCapture: { saveAsMHTML: async () => { calls.push('capture'); return new Blob(['mhtml']); } },
      storage: { session: { set: async (value) => { storedDebug = value.ai_geo_doubao_snapshot_debug; }, get: async () => ({ ai_geo_doubao_snapshot_debug: storedDebug }) } }
    },
    indexedDB: fakeIndexedDb(records)
  });
  vm.runInContext(source, context);
  const input = { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', observation_id: 'final' }, observation: { unchanged: true } };
  const first = await dispatch(listeners[0], input);
  const second = await dispatch(listeners[0], input);
  assert.equal(first.status, 'captured');
  assert.equal(first.bytes, 5);
  assert.equal(second.status, 'deduped');
  assert.deepEqual(calls.filter((value) => value === 'capture'), ['capture']);
  assert.equal(calls.filter((value) => value === 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE').length, 1);
  assert.equal(storedDebug.background_received, true);
  assert.equal(storedDebug.capture_ok, true);
  assert.equal(storedDebug.storage_ok, true);
  assert.equal(storedDebug.stored_bytes, 5);
  assert.equal(records.size, 1);
  const record = [...records.values()][0];
  assert.deepEqual({ snapshot_id: record.snapshot_id, platform: record.platform, conversation_url: record.conversation_url, conversation_id: record.conversation_id, observation_id: record.observation_id, bytes: record.bytes, mime_type: record.mime_type }, {
    snapshot_id: 'doubao|https://www.doubao.com/chat/current', platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', conversation_id: 'current', observation_id: 'final', bytes: 5, mime_type: 'multipart/related'
  });
  assert.equal(record.blob.size, 5);
  assert.equal(context.chrome.downloads, undefined);

  context.chrome.pageCapture.saveAsMHTML = async () => { throw new Error('synthetic capture failure'); };
  const failed = await dispatch(listeners[0], { ...input, trigger: { ...input.trigger, conversation_url: 'https://www.doubao.com/chat/failure', observation_id: 'failure' } });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /synthetic capture failure/);
  assert.equal(calls.filter((value) => value === 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE').length, 2);
  assert.equal(storedDebug.capture_failed, true);
  assert.match(storedDebug.last_error, /synthetic capture failure/);
  assert.deepEqual(input.observation, { unchanged: true });

  const debug = await dispatch(listeners[0], { type: 'GET_SNAPSHOT_DEBUG_STATE' });
  assert.equal(debug.capture_failed, true);
});

test('Doubao Extension background ignores a new observation ID for the same conversation while Snapshot is in flight', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = [];
  const calls = [];
  const records = new Map();
  let releaseCapture;
  let captureStarted;
  const started = new Promise((resolve) => { captureStarted = resolve; });
  const context = vm.createContext({
    Blob,
    URL,
    queueMicrotask,
    console: { error: () => {} },
    chrome: {
      runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
      tabs: { sendMessage: async (_tabId, message) => message.type.endsWith('PREPARE') ? { prepared: true } : { restored: true } },
      pageCapture: { saveAsMHTML: async () => { calls.push('capture'); captureStarted(); return new Promise((resolve) => { releaseCapture = resolve; }); } },
      storage: { session: { set: async () => {}, get: async () => ({}) } }
    },
    indexedDB: fakeIndexedDb(records)
  });
  vm.runInContext(source, context);
  const first = dispatch(listeners[0], { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', observation_id: 'A' }, observation: { unchanged: true } });
  await started;
  const second = await dispatch(listeners[0], { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', observation_id: 'B' }, observation: { unchanged: true } });
  assert.equal(second.status, 'deduped');
  assert.deepEqual(calls, ['capture']);
  releaseCapture(new Blob(['mhtml']));
  assert.equal((await first).status, 'captured');
  assert.equal(records.size, 1);
  assert.equal([...records.values()][0].observation_id, 'A');
});

test('Doubao Extension background releases a failed conversation for a later retry', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = [];
  const records = new Map();
  const context = vm.createContext({
    Blob,
    URL,
    queueMicrotask,
    console: { error: () => {} },
    chrome: {
      runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
      tabs: { sendMessage: async (_tabId, message) => message.type.endsWith('PREPARE') ? { prepared: true } : { restored: true } },
      pageCapture: { saveAsMHTML: async () => { throw new Error('synthetic capture failure'); } },
      storage: { session: { set: async () => {}, get: async () => ({}) } }
    },
    indexedDB: fakeIndexedDb(records)
  });
  vm.runInContext(source, context);
  const first = await dispatch(listeners[0], { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/retry', observation_id: 'A' }, observation: { unchanged: true } });
  assert.equal(first.status, 'failed');
  context.chrome.pageCapture.saveAsMHTML = async () => new Blob(['mhtml']);
  const retry = await dispatch(listeners[0], { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/retry', observation_id: 'B' }, observation: { unchanged: true } });
  assert.equal(retry.status, 'captured');
  assert.equal(records.size, 1);
});

test('Doubao Extension background isolates IndexedDB storage failures and restores the live page', async () => {
  const source = await readFile(new URL('background.js', extensionRoot), 'utf8');
  const listeners = [];
  const calls = [];
  let storedDebug = null;
  const context = vm.createContext({
    Blob,
    URL,
    queueMicrotask,
    console: { error: () => {} },
    chrome: {
      runtime: { onMessage: { addListener(listener) { listeners.push(listener); } } },
      tabs: { sendMessage: async (_tabId, message) => { calls.push(message.type); return message.type.endsWith('PREPARE') ? { prepared: true } : { restored: true }; } },
      pageCapture: { saveAsMHTML: async () => new Blob(['mhtml']) },
      storage: { session: { set: async (value) => { storedDebug = value.ai_geo_doubao_snapshot_debug; }, get: async () => ({ ai_geo_doubao_snapshot_debug: storedDebug }) } }
    },
    indexedDB: fakeIndexedDb(new Map(), new Error('synthetic storage failure'))
  });
  vm.runInContext(source, context);
  const observation = { unchanged: true };
  const result = await dispatch(listeners[0], { type: 'AI_GEO_DOUBAO_SNAPSHOT_READY', trigger: { platform: 'doubao', conversation_url: 'https://www.doubao.com/chat/current', observation_id: 'storage-failure' }, observation });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /synthetic storage failure/);
  assert.equal(storedDebug.storage_failed, true);
  assert.match(storedDebug.last_error, /synthetic storage failure/);
  assert.equal(calls.filter((value) => value === 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE').length, 1);
  assert.deepEqual(observation, { unchanged: true });
});

test('Extension manifest enables only the required Doubao capture and storage permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
  assert.deepEqual(manifest.permissions, ['pageCapture', 'storage']);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.content_scripts[1].js.includes('platforms/doubao/extension-snapshot.js'), true);
  assert.deepEqual(manifest.options_ui, { page: 'snapshot-debug.html', open_in_tab: true });
});

test('Snapshot debug page selects the latest artifact from every platform and directly saves it only after a user click', async () => {
  const html = await readFile(new URL('snapshot-debug.html', extensionRoot), 'utf8');
  const source = await readFile(new URL('snapshot-debug.js', extensionRoot), 'utf8');
  const { document, elements, exports } = debugDocument();
  const records = [
    { platform: 'doubao', captured_at: '2026-09-15T08:00:00.000Z', conversation_url: 'https://www.doubao.com/chat/old', snapshot_id: 'old', bytes: 3, filename: 'old.mhtml', blob: new Blob(['old']) },
    { platform: 'doubao', captured_at: '2026-09-15T09:00:00.000Z', conversation_url: 'https://www.doubao.com/chat/new', snapshot_id: 'new', bytes: 5, filename: 'new.mhtml', blob: new Blob(['newer']) },
    { platform: 'deepseek', captured_at: '2026-09-15T10:00:00.000Z', conversation_url: 'https://chat.deepseek.com/a/chat/s/new', snapshot_id: 'other', bytes: 7, filename: 'deepseek-snapshot-v3-new.mhtml', blob: new Blob(['content']) }
  ];
  const context = vm.createContext({ document, indexedDB: fakeReadIndexedDb(records), showSaveFilePicker: async (options) => {
    exports.pickerOptions = options;
    return { createWritable: async () => ({ write: async (blob) => { exports.writes.push(blob); }, close: async () => { exports.closed += 1; } }) };
  }, console });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(html, /导出最新快照/);
  assert.match(html, /保存时间/);
  assert.match(html, /会话 URL/);
  assert.equal(elements.platform.textContent, 'deepseek');
  assert.equal(elements['conversation-url'].textContent, 'https://chat.deepseek.com/a/chat/s/new');
  assert.equal(elements['captured-at'].textContent, '2026-09-15T10:00:00.000Z');
  assert.equal(elements.bytes.textContent, '7 bytes');
  assert.equal(elements['snapshot-id'].textContent, 'other');
  assert.equal(elements.export.disabled, false);
  assert.equal(exports.writes.length, 0);
  await elements.export.listeners.click();
  assert.equal(exports.writes[0].size, 7);
  assert.equal(exports.closed, 1);
  assert.equal(exports.pickerOptions.suggestedName, 'deepseek-snapshot-v3-new.mhtml');
  assert.deepEqual([...exports.pickerOptions.types[0].accept['multipart/related']], ['.mhtml']);
  assert.equal(elements['save-status'].textContent, '测试快照已保存。');

  context.showSaveFilePicker = async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; };
  await elements.export.listeners.click();
  assert.equal(elements['save-status'].textContent, '已取消保存。');
  assert.equal(exports.writes.length, 1);

  context.showSaveFilePicker = undefined;
  await elements.export.listeners.click();
  assert.equal(elements['save-status'].textContent, '当前浏览器不支持直接保存测试快照。');
  assert.doesNotMatch(source, /createObjectURL/);
  assert.doesNotMatch(source, /<a/);
  assert.doesNotMatch(source, /chrome\.downloads/);

  const emptyPage = debugDocument();
  const emptyContext = vm.createContext({ document: emptyPage.document, indexedDB: fakeReadIndexedDb([]), console });
  vm.runInContext(source, emptyContext);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emptyPage.elements.empty.hidden, false);
  assert.equal(emptyPage.elements.export.disabled, true);
});

async function message(page, payload) {
  return page.evaluate(async (message) => new Promise((resolve) => globalThis.__messages[0](message, {}, resolve)), payload);
}

async function dispatch(listener, message) {
  return new Promise((resolve) => {
    const asyncResponse = listener(message, { tab: { id: 3 } }, resolve);
    assert.equal(asyncResponse, true);
  });
}

async function snapshotPage(browser, initiallyExpanded, { respondsToClick = true, collapsesWhenControlIsRestored = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`<div class="main-with-nav-qLRcbu"><aside class="container-hzjmF1">sidebar</aside><main><button id="reference-control" aria-expanded="${initiallyExpanded}">搜索 2 个关键词，参考 2 篇资料</button><ul id="references" style="display:${initiallyExpanded ? 'block' : 'none'}"><li><a href="https://source.example">来源网站</a></li></ul><article>answer</article></main></div><div style="position:fixed;bottom:0;height:140px"><div contenteditable="true">composer</div><button>send</button></div>`);
  await page.evaluate(({ enabled, collapseOnRestore }) => {
    globalThis.referenceClicks = 0;
    const control = document.getElementById('reference-control');
    control.addEventListener('click', () => {
      globalThis.referenceClicks += 1;
      if (!enabled) return;
      control.setAttribute('aria-expanded', 'true');
      document.getElementById('references').style.display = 'block';
    });
    if (collapseOnRestore) {
      new MutationObserver(() => {
        if (control.hasAttribute('disabled')) return;
        control.setAttribute('aria-expanded', 'false');
        document.getElementById('references').style.display = 'none';
      }).observe(control, { attributes: true, attributeFilter: ['disabled'] });
    }
    globalThis.__messages = [];
    globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.__messages.push(listener); } } } };
  }, { enabled: respondsToClick, collapseOnRestore: collapsesWhenControlIsRestored });
  const source = await readFile(new URL('platforms/doubao/extension-snapshot.js', extensionRoot), 'utf8');
  await page.evaluate(source);
  return page;
}

function fakeIndexedDb(records, writeError = null) {
  return {
    open() {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const database = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        close: () => {},
        transaction: () => {
          const transaction = { error: null, oncomplete: null, onerror: null, onabort: null };
          transaction.objectStore = () => ({ put(record) {
            const put = { error: null, onerror: null };
            queueMicrotask(() => {
              if (writeError) {
                put.error = writeError;
                put.onerror?.();
                return;
              }
              records.set(record.snapshot_id, record);
              transaction.oncomplete?.();
            });
            return put;
          } });
          return transaction;
        }
      };
      request.result = database;
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };
}

function fakeReadIndexedDb(records) {
  return {
    open() {
      const request = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        close: () => {},
        transaction: () => ({ objectStore: () => ({ getAll() {
          const getAll = { result: null, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => { getAll.result = records; getAll.onsuccess?.(); });
          return getAll;
        } }) })
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };
}

function debugDocument() {
  const exports = { writes: [], closed: 0, pickerOptions: null };
  const element = () => ({ hidden: false, disabled: false, textContent: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
  const elements = { empty: element(), details: element(), export: element(), platform: element(), 'captured-at': element(), 'conversation-url': element(), bytes: element(), 'snapshot-id': element(), 'save-status': element() };
  const document = {
    readyState: 'complete',
    getElementById(id) { return elements[id]; },
    body: { append() {} }
  };
  return { document, elements, exports };
}
