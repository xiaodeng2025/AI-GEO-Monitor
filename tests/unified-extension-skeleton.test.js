import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const root = new URL('../extension/ai-geo-monitor-unified/', import.meta.url);
const readAsset = (path) => readFile(new URL(path, root), 'utf8');
const manifest = JSON.parse(await readAsset('manifest.json'));
const registrySource = await readAsset('shared/platform-registry.js');
const routerSource = await readAsset('shared/router.js');
const runtimeSource = await readAsset('shared/runtime.js');
const doubaoContentSource = await readAsset('platforms/doubao/content.js');
const doubaoProbeSource = await readAsset('platforms/doubao/response-probe.js');
const deepseekContentSource = await readAsset('platforms/deepseek/content.js');
const yuanbaoContentSource = await readAsset('platforms/yuanbao/content.js');
const yuanbaoProbeSource = await readAsset('platforms/yuanbao/page-response-observer.js');
const wenxinContentSource = await readAsset('platforms/wenxin/content.js');
const wenxinProbeSource = await readAsset('platforms/wenxin/page-response-observer.js');
const bootstrapSources = Object.fromEntries(await Promise.all([
  ['doubao', 'platforms/doubao/bootstrap.js'],
  ['yuanbao', 'platforms/yuanbao/bootstrap.js'],
  ['deepseek', 'platforms/deepseek/bootstrap.js'],
  ['wenxin', 'platforms/wenxin/bootstrap.js']
].map(async ([id, path]) => [id, await readAsset(path)])));

function loadRuntime(url) {
  const context = vm.createContext({ URL, location: { href: url }, console });
  vm.runInContext(registrySource, context);
  vm.runInContext(routerSource, context);
  vm.runInContext(runtimeSource, context);
  return context;
}

test('unified manifest has only exact current hosts and the scoped Doubao Snapshot permissions', () => {
  assert.deepEqual(manifest.permissions, ['pageCapture', 'storage']);
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  const matches = manifest.content_scripts.flatMap((entry) => entry.matches);
  assert.deepEqual([...new Set(matches)], [
    'https://www.doubao.com/*',
    'https://yuanbao.tencent.com/*',
    'https://chat.deepseek.com/*',
    'https://wenxin.baidu.com/*'
  ]);
  assert.equal(matches.some((match) => match.includes('kimi') || match.includes('*.baidu.com') || match.includes('chat.baidu.com')), false);
  assert.equal(matches.some((match) => match.includes('*://') || match.includes('*/*')), false);
  assert.equal(manifest.content_scripts.filter((entry) => entry.matches.includes('https://www.doubao.com/*')).length, 2);
});

test('Wenxin preserves frozen observers and publishes partial states through Unified runtime', () => {
  const mainEntry = manifest.content_scripts.find((entry) => entry.world === 'MAIN' && entry.matches.includes('https://wenxin.baidu.com/*'));
  const adapterEntry = manifest.content_scripts.find((entry) => entry.js.includes('platforms/wenxin/content.js'));
  assert.deepEqual(mainEntry.js, ['platforms/wenxin/page-response-observer.js']);
  assert.equal(mainEntry.run_at, 'document_start');
  assert.deepEqual(adapterEntry.js, ['shared/platform-registry.js', 'shared/router.js', 'shared/observation-snapshot-trigger.js', 'shared/runtime.js', 'platforms/wenxin/extension-snapshot.js', 'platforms/wenxin/content.js', 'platforms/wenxin/bootstrap.js']);
  assert.match(wenxinProbeSource, /https:\/\/chat\.baidu\.com/);
  assert.match(wenxinContentSource, /revalidateSearchObservation/);
  assert.match(wenxinContentSource, /processing: \{ status: 'not_observed' \}/);
  assert.match(wenxinContentSource, /formal_citation/);
  assert.match(wenxinContentSource, /activatePlatform\('wenxin'\)/);
  assert.match(wenxinContentSource, /publishObservation\(result, fingerprint\)/);
});

test('Wenxin publishes a Search-first observation before Final Answer exists', () => {
  const listeners = new Map();
  const publications = [];
  const document = {
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: (name, handler) => listeners.set(name, handler)
  };
  const context = vm.createContext({
    JSON, Date, document, location: { host: 'wenxin.baidu.com', pathname: '/search/example' },
    addEventListener: (name, handler) => listeners.set(name, handler),
    clearTimeout: () => {}, setTimeout: () => null,
    MutationObserver: class { observe() {} },
    __AI_GEO_UNIFIED_EXTENSION_RUNTIME__: { activatePlatform: () => ({ publishObservation: (result, fingerprint) => publications.push({ result, fingerprint }) }) }
  });
  vm.runInContext(wenxinContentSource, context);
  listeners.get('__AI_GEO_WENXIN_POC_SEARCH_OBSERVATION__')({ detail: JSON.stringify({
    endpoint: { origin: 'https://chat.baidu.com', pathname: '/csaitab/searchresult' },
    request: { query: 'q', pn: '0', rn: '1' }, transport: 'fetch', captured_at: '2026-09-11T00:00:00.000Z',
    response: { status: 0, message: 'ok' }, results: [{ title: 'result' }]
  }) });
  assert.equal(publications.length, 1);
  assert.equal(publications[0].result.final_answer.status, 'not_observed');
  assert.equal(publications[0].result.final_answer.html, '');
  assert.equal(publications[0].result.search.occurrence_count, 1);
  assert.equal(publications[0].result.raw_acquisition.status, 'observed');
});

async function unifiedWenxinFixture(html, url = 'https://wenxin.baidu.com/search/fixture-result?enter_type=sidebar_dialog') {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(() => {
    globalThis.__AI_GEO_TEST_PUBLICATIONS__ = [];
    globalThis.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__ = {
      activatePlatform: () => ({
        publishObservation: (result, fingerprint) => globalThis.__AI_GEO_TEST_PUBLICATIONS__.push({ result, fingerprint })
      })
    };
  });
  await page.addScriptTag({ content: wenxinContentSource });
  return { browser, page, publications: () => page.evaluate(() => globalThis.__AI_GEO_TEST_PUBLICATIONS__) };
}

async function waitForWenxinPublications(page, publications, count) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await publications()).length >= count) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${count} Wenxin publication(s).`);
}

test('Unified Wenxin preserves same-node Final Answer HTML, fallback, and meaningful HTML-only changes', async (t) => {
  const { browser, page, publications } = await unifiedWenxinFixture(`
    <main data-page-global="excluded">outside page content</main>
    <article class="ai-entry" data-entry="old">
      <div class="ai-entry-block ai-markdown"><div class="cosd-markdown-content"><p>old answer only</p></div></div>
    </article>
    <article class="ai-entry" data-entry="current" data-container-only="excluded">
      <div class="ai-entry-block ai-markdown" data-show-log='{"component_name":"markdown"}'>
        <div class="cosd-markdown-content">
          <p>Current <strong>formatted</strong> answer <a href="https://source.example/a">source link</a></p>
          <ul><li>First visible item</li><li><em>Second visible item</em></li></ul>
        </div>
      </div>
      <div class="ai-entry-block ai-thinking-steps">共参考 2 篇资料<ol><li data-long-press-menu="menu" data-long-press-ext-info='{"link":"https://pool.example/a","linkTitle":"Pool A"}'>Pool A</li><li data-long-press-ext-info='{"link":"https://pool.example/b","linkTitle":"Pool B"}'>Pool B</li></ol></div>
    </article>
  `);
  t.after(() => browser.close());

  await waitForWenxinPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.conversation_url, 'https://wenxin.baidu.com/search/fixture-result?enter_type=sidebar_dialog');
  assert.equal(first.result.final_answer.status, 'observed');
  assert.equal(first.result.final_answer.text.includes('Current formatted answer'), true);
  assert.equal(first.result.final_answer.html.includes('<strong>formatted</strong>'), true);
  assert.equal(first.result.final_answer.html.includes('<ul>'), true);
  assert.equal(first.result.final_answer.html.includes('<em>Second visible item</em>'), true);
  assert.equal(first.result.final_answer.html.includes('https://source.example/a'), true);
  assert.equal(first.result.final_answer.html.includes('old answer only'), false);
  assert.equal(first.result.final_answer.html.includes('outside page content'), false);
  assert.equal(first.result.final_answer.html.includes('Pool A'), false);
  assert.equal(first.result.final_answer.html.includes('data-container-only'), false);
  assert.deepEqual(first.result.source_pool.items.map((item) => item.link), ['https://pool.example/a', 'https://pool.example/b']);
  assert.equal(first.result.search.dom_status, 'not_observed');
  assert.equal(first.result.processing.status, 'not_observed');
  assert.equal(first.result.formal_citation.status, 'candidate_observed');
  assert.deepEqual(first.result.formal_citation.candidates, [{ tag: 'a', text: 'source link' }]);

  await page.evaluate(() => {
    document.querySelector('[data-entry="current"]').innerHTML = `
      <div class="ai-entry-block ai-markdown"><p>Fallback <strong>content</strong></p></div>
      <div class="ai-entry-block ai-thinking-steps">共参考 1 篇资料<ol><li data-long-press-ext-info='{"link":"https://pool.example/c","linkTitle":"Pool C"}'>Pool C</li></ol></div>
    `;
  });
  await waitForWenxinPublications(page, publications, 2);
  const fallback = (await publications())[1];
  assert.equal(fallback.result.final_answer.text, 'Fallback content');
  assert.equal(fallback.result.final_answer.html.includes('<strong>content</strong>'), true);
  assert.equal(fallback.result.final_answer.html.includes('Pool C'), false);
  assert.deepEqual(fallback.result.source_pool.items.map((item) => item.link), ['https://pool.example/c']);

  await page.evaluate(() => {
    const answer = document.querySelector('[data-entry="current"] .ai-entry-block.ai-markdown');
    answer.querySelector('strong').replaceWith(Object.assign(document.createElement('em'), { textContent: 'content' }));
  });
  await waitForWenxinPublications(page, publications, 3);
  const changed = (await publications())[2];
  assert.equal(changed.result.final_answer.text, fallback.result.final_answer.text);
  assert.notEqual(changed.result.final_answer.html, fallback.result.final_answer.html);
  assert.equal(changed.result.final_answer.html.includes('<em>content</em>'), true);
  assert.notEqual(changed.fingerprint, fallback.fingerprint);
  await page.waitForTimeout(500);
  assert.equal((await publications()).length, 3);
});

test('Unified Wenxin preserves only a strict current official conversation/result URL', async (t) => {
  const fixtureHtml = '<article class="ai-entry"><div class="ai-entry-block ai-markdown"><div class="cosd-markdown-content"><p>Current answer</p></div></div><div class="ai-entry-block ai-thinking-steps">共参考 1 篇资料<ol><li data-long-press-ext-info=\'{"link":"https://pool.example/a","linkTitle":"Pool A"}\'>Pool A</li></ol></div></article>';
  const { browser, page, publications } = await unifiedWenxinFixture(fixtureHtml, 'https://wenxin.baidu.com/search/first-fixture?enter_type=sidebar_dialog');
  t.after(() => browser.close());

  await waitForWenxinPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.conversation_url, 'https://wenxin.baidu.com/search/first-fixture?enter_type=sidebar_dialog');
  assert.equal(first.result.final_answer.text, 'Current answer');
  assert.equal(first.result.final_answer.html, '<p>Current answer</p>');
  assert.deepEqual(first.result.source_pool.items.map((item) => item.link), ['https://pool.example/a']);
  assert.equal(first.result.search.dom_status, 'not_observed');
  assert.equal(first.result.processing.status, 'not_observed');
  assert.equal(first.result.formal_citation.status, 'not_observed');
  assert.equal(first.result.raw_acquisition.privacy, 'sanitized_allowlist_only');
  await page.waitForTimeout(500);
  assert.equal((await publications()).length, 1);

  await page.evaluate(() => {
    history.pushState({}, '', '/search/second-fixture?enter_type=sidebar_dialog');
    document.body.append(document.createComment('conversation-url-change'));
  });
  await waitForWenxinPublications(page, publications, 2);
  const changed = (await publications())[1];
  assert.equal(changed.result.conversation_url, 'https://wenxin.baidu.com/search/second-fixture?enter_type=sidebar_dialog');
  assert.equal(changed.result.final_answer.text, first.result.final_answer.text);
  assert.equal(changed.result.final_answer.html, first.result.final_answer.html);
  assert.deepEqual(changed.result.source_pool, first.result.source_pool);
  assert.deepEqual(changed.result.search, first.result.search);
  assert.deepEqual(changed.result.processing, first.result.processing);
  assert.deepEqual(changed.result.formal_citation, first.result.formal_citation);
  assert.deepEqual(changed.result.raw_acquisition, first.result.raw_acquisition);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  for (const path of ['/', '/explore', '/search/', '/search/a/b']) {
    const expectedCount = (await publications()).length + 1;
    await page.evaluate((nextPath) => {
      history.pushState({}, '', nextPath);
      document.body.append(document.createComment('invalid-conversation-url'));
    }, path);
    await waitForWenxinPublications(page, publications, expectedCount);
    assert.equal((await publications()).at(-1).result.conversation_url, '', path);
  }

  for (const href of ['https://example.test/search/a', 'http://wenxin.baidu.com/search/a']) {
    const invalid = await unifiedWenxinFixture(fixtureHtml, href);
    try {
      await waitForWenxinPublications(invalid.page, invalid.publications, 1);
      assert.equal((await invalid.publications())[0].result.conversation_url, '', href);
    } finally {
      await invalid.browser.close();
    }
  }
});

test('each exact host entry loads only its own platform bootstrap', () => {
  const entries = [
    ['doubao', manifest.content_scripts.find((entry) => entry.js.includes('platforms/doubao/bootstrap.js'))],
    ['yuanbao', manifest.content_scripts.find((entry) => entry.js.includes('platforms/yuanbao/bootstrap.js'))],
    ['deepseek', manifest.content_scripts.find((entry) => entry.js.includes('platforms/deepseek/bootstrap.js'))],
    ['wenxin', manifest.content_scripts.find((entry) => entry.js.includes('platforms/wenxin/bootstrap.js'))]
  ];
  entries.forEach(([id, entry]) => {
    assert.ok(entry);
    assert.equal(entry.matches.length, 1);
    assert.equal(entry.matches[0], `https://${id === 'doubao' ? 'www.doubao.com' : id === 'yuanbao' ? 'yuanbao.tencent.com' : id === 'wenxin' ? 'wenxin.baidu.com' : 'chat.deepseek.com'}/*`);
    assert.match(bootstrapSources[id], new RegExp(`activatePlatform\\(['"]${id}['"]\\)`));
    ['doubao', 'yuanbao', 'deepseek', 'wenxin'].filter((otherId) => otherId !== id).forEach((otherId) => {
      assert.doesNotMatch(entry.js.join('\n'), new RegExp(`platforms/${otherId}/`));
    });
  });
});

test('Doubao MAIN probe and isolated adapter are scoped only to the Doubao host', async () => {
  const probeEntry = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
  const adapterEntry = manifest.content_scripts.find((entry) => entry.js.includes('platforms/doubao/content.js'));
  assert.deepEqual(probeEntry.matches, ['https://www.doubao.com/*']);
  assert.deepEqual(probeEntry.js, ['platforms/doubao/response-probe.js']);
  assert.deepEqual(adapterEntry.matches, ['https://www.doubao.com/*']);
  assert.equal(adapterEntry.world, undefined);
  assert.match(doubaoContentSource, /__AI_GEO_UNIFIED_EXTENSION_RUNTIME__/);
  assert.match(doubaoContentSource, /current_search_reference_mapping/);
  assert.match(doubaoProbeSource, /\/im\/conversation\/batch_get/);
});

async function unifiedDoubaoFixture(html, url = 'https://www.doubao.com/chat/fixture-conversation') {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(() => {
    globalThis.__AI_GEO_TEST_PUBLICATIONS__ = [];
    globalThis.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__ = {
      activatePlatform: () => ({
        publishObservation: (result, fingerprint) => globalThis.__AI_GEO_TEST_PUBLICATIONS__.push({ result, fingerprint })
      })
    };
  });
  await page.addScriptTag({ content: doubaoContentSource });
  return { browser, page, publications: () => page.evaluate(() => globalThis.__AI_GEO_TEST_PUBLICATIONS__) };
}

async function waitForDoubaoPublications(page, publications, count) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await publications()).length >= count) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${count} Doubao publication(s).`);
}

test('Unified Doubao preserves only a strict current official conversation URL', async (t) => {
  const fixtureHtml = '<main><div data-message-role="user">Single monitoring query</div><section><button aria-expanded="false">搜索 1 个关键词，参考 1 篇资料</button></section><article data-message-role="assistant"><p>Single answer <a href="https://source.example/a">source</a></p></article></main>';
  const { browser, page, publications } = await unifiedDoubaoFixture(fixtureHtml, 'https://www.doubao.com/chat/first-fixture-id');
  t.after(() => browser.close());

  await waitForDoubaoPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.conversation_url, 'https://www.doubao.com/chat/first-fixture-id');
  assert.equal(first.result.question.text, 'Single monitoring query');
  assert.equal(first.result.answer.text, 'Single answer source');
  assert.equal(first.result.answer.html.includes('https://source.example/a'), true);
  assert.equal(first.result.search_reference.summary, '搜索 1 个关键词，参考 1 篇资料');
  assert.equal(first.result.search_reference.references, null);
  assert.equal(first.result.formal_citations.length, 0);
  assert.equal(first.result.processing_status, 'not_observed');
  assert.deepEqual(first.result.response_facts, []);
  await page.waitForTimeout(1_300);
  assert.equal((await publications()).length, 1);

  await page.evaluate(() => {
    history.pushState({}, '', '/chat/second-fixture-id');
    document.body.append(document.createComment('conversation-url-change'));
  });
  await waitForDoubaoPublications(page, publications, 2);
  const changed = (await publications())[1];
  assert.equal(changed.result.conversation_url, 'https://www.doubao.com/chat/second-fixture-id');
  assert.deepEqual(changed.result.question, first.result.question);
  assert.deepEqual(changed.result.answer, first.result.answer);
  assert.deepEqual(changed.result.search_reference, first.result.search_reference);
  assert.deepEqual(changed.result.formal_citations, first.result.formal_citations);
  assert.equal(changed.result.processing_status, first.result.processing_status);
  assert.deepEqual(changed.result.response_facts, first.result.response_facts);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  for (const path of ['/', '/explore', '/chat/', '/chat/a/b']) {
    await page.evaluate((nextPath) => {
      history.pushState({}, '', nextPath);
      document.body.append(document.createComment('invalid-conversation-url'));
    }, path);
    const result = await page.evaluate(() => globalThis.__AI_GEO_DOUBAO_SPIKE__.capture());
    assert.equal(result.conversation_url, '', path);
  }

  for (const href of ['https://example.test/chat/a', 'http://www.doubao.com/chat/a']) {
    const invalid = await unifiedDoubaoFixture(fixtureHtml, href);
    try {
      await waitForDoubaoPublications(invalid.page, invalid.publications, 1);
      assert.equal((await invalid.publications())[0].result.conversation_url, '', href);
    } finally {
      await invalid.browser.close();
    }
  }
});

test('DeepSeek isolated adapter preserves frozen semantics and only publishes through shared runtime', () => {
  const entry = manifest.content_scripts.find((candidate) => candidate.js.includes('platforms/deepseek/content.js'));
  assert.deepEqual(entry.matches, ['https://chat.deepseek.com/*']);
  assert.equal(entry.world, undefined);
  assert.match(deepseekContentSource, /\.ds-markdown\.ds-assistant-message-main-content/);
  assert.match(deepseekContentSource, /\.ds-markdown-cite/);
  assert.match(deepseekContentSource, /platform_reported_source_count/);
  assert.match(deepseekContentSource, /__AI_GEO_UNIFIED_EXTENSION_RUNTIME__/);
  const doubaoEntry = manifest.content_scripts.find((candidate) => candidate.js.includes('platforms/doubao/content.js'));
  const yuanbaoEntry = manifest.content_scripts.find((candidate) => candidate.js.includes('platforms/yuanbao/bootstrap.js'));
  assert.equal(doubaoEntry.js.some((script) => script.includes('deepseek')), false);
  assert.equal(yuanbaoEntry.js.some((script) => script.includes('deepseek')), false);
});

async function unifiedDeepSeekFixture(html, url = 'https://chat.deepseek.com/a/chat/s/fixture-conversation') {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.setContent(html);
  const consoleResults = [];
  page.on('console', (message) => {
    if (message.type() !== 'info' || !message.text().startsWith('[AI-GEO DeepSeek read-only spike] ')) return;
    consoleResults.push(JSON.parse(message.text().slice('[AI-GEO DeepSeek read-only spike] '.length)));
  });
  await page.evaluate(() => {
    globalThis.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__ = {
      activatePlatform: () => ({
        publishObservation: (result, fingerprint) => globalThis.__AI_GEO_TEST_PUBLICATIONS__.push({ result, fingerprint })
      })
    };
    globalThis.__AI_GEO_TEST_PUBLICATIONS__ = [];
  });
  await page.addScriptTag({ content: deepseekContentSource });
  return { browser, page, publications: () => page.evaluate(() => globalThis.__AI_GEO_TEST_PUBLICATIONS__), consoleResults };
}

function deepSeekLocationOnlyCapture(href) {
  const document = { documentElement: {}, querySelectorAll: () => [] };
  const context = vm.createContext({
    URL, document, location: href === undefined ? undefined : { href },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    clearTimeout: () => {}, setTimeout: () => null,
    MutationObserver: class { observe() {} }, console: { info() {} }
  });
  vm.runInContext(deepseekContentSource, context);
  return context.__AI_GEO_DEEPSEEK_SPIKE__.capture();
}

async function waitForDeepSeekPublications(page, publications, count) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await publications()).length >= count) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${count} DeepSeek publication(s).`);
}

test('Unified DeepSeek preserves same-node Final Answer HTML and republishes meaningful HTML-only changes', async (t) => {
  const { browser, page, publications, consoleResults } = await unifiedDeepSeekFixture(`
    <main data-page-global="excluded">outside page content</main>
    <div class="ds-message" data-message-id="old-response">
      <div class="ds-markdown ds-assistant-message-main-content"><p>old answer only</p></div>
    </div>
    <div class="ds-message" data-message-id="current-response" data-container-only="excluded">
      <div class="ds-markdown ds-assistant-message-main-content">
        <p>Current <strong>formatted</strong> answer <a href="https://source.example/a"><span class="ds-markdown-cite">1</span></a></p>
        <ul><li>First visible item</li><li><em>Second visible item</em></li></ul>
        <p><a href="https://source.example/b"><span class="ds-markdown-cite">2</span></a><a href="https://source.example/a"><span class="ds-markdown-cite">3</span></a></p>
      </div>
      <div>已阅读 8 个网页</div>
    </div>
  `);
  t.after(() => browser.close());

  await waitForDeepSeekPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.conversation_url, 'https://chat.deepseek.com/a/chat/s/fixture-conversation');
  assert.equal(first.result.answer.includes('Current formatted answer'), true);
  assert.equal(first.result.answer_html.includes('<strong>formatted</strong>'), true);
  assert.equal(first.result.answer_html.includes('<ul>'), true);
  assert.equal(first.result.answer_html.includes('<em>Second visible item</em>'), true);
  assert.equal(first.result.answer_html.includes('ds-markdown-cite'), true);
  assert.equal(first.result.answer_html.includes('old answer only'), false);
  assert.equal(first.result.answer_html.includes('outside page content'), false);
  assert.equal(first.result.answer_html.includes('data-container-only'), false);
  assert.deepEqual(first.result.citation_occurrences, [
    { position: 1, url: 'https://source.example/a' },
    { position: 2, url: 'https://source.example/b' },
    { position: 3, url: 'https://source.example/a' }
  ]);
  assert.deepEqual(first.result.unique_citation_urls, ['https://source.example/a', 'https://source.example/b']);
  assert.equal(first.result.platform_reported_source_count, 8);
  assert.equal(consoleResults.length, 1);

  await page.evaluate(() => {
    const finalAnswer = document.querySelector('[data-message-id="current-response"] .ds-markdown.ds-assistant-message-main-content');
    finalAnswer.querySelector('strong').replaceWith(Object.assign(document.createElement('em'), { textContent: 'formatted' }));
  });
  await waitForDeepSeekPublications(page, publications, 2);
  const second = (await publications())[1];
  assert.equal(second.result.answer, first.result.answer);
  assert.notEqual(second.result.answer_html, first.result.answer_html);
  assert.equal(second.result.answer_html.includes('<em>formatted</em>'), true);
  assert.deepEqual(second.result.citation_occurrences, first.result.citation_occurrences);
  assert.equal(second.result.platform_reported_source_count, 8);
  assert.notEqual(second.fingerprint, first.fingerprint);
  await page.waitForTimeout(1_300);
  assert.equal((await publications()).length, 2);
  assert.equal(consoleResults.length, 2);
});

test('Unified DeepSeek captures only a uniquely paired Question and fails closed otherwise', async (t) => {
  const { browser, page, publications } = await unifiedDeepSeekFixture(`
    <div data-virtual-list-item-key="-11"><div class="ds-message">First question</div></div>
    <div data-virtual-list-item-key="11"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">First answer</div></div></div>
    <div data-virtual-list-item-key="-29"><div class="ds-message">Second question<button>excluded control</button></div></div>
    <div data-virtual-list-item-key="29"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Second answer <a href="https://source.example/a"><span class="ds-markdown-cite">1</span></a></div><div>已阅读 6 个网页</div></div></div>
  `);
  t.after(() => browser.close());

  await waitForDeepSeekPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.question, 'Second question');
  assert.equal(first.result.question.includes('excluded control'), false);
  assert.equal(first.result.answer, 'Second answer 1');
  assert.equal(first.result.answer_html.includes('Second answer'), true);
  assert.equal(first.result.answer_html.includes('First answer'), false);
  assert.deepEqual(first.result.citation_occurrences, [{ position: 1, url: 'https://source.example/a' }]);
  assert.equal(first.result.platform_reported_source_count, 6);

  await page.evaluate(() => {
    const question = document.querySelector('[data-virtual-list-item-key="-29"] .ds-message');
    question.firstChild.textContent = 'Updated second question';
  });
  await waitForDeepSeekPublications(page, publications, 2);
  const changedQuestion = (await publications())[1];
  assert.equal(changedQuestion.result.question, 'Updated second question');
  assert.equal(changedQuestion.result.answer, first.result.answer);
  assert.equal(changedQuestion.result.answer_html, first.result.answer_html);
  assert.notEqual(changedQuestion.fingerprint, first.fingerprint);
  await page.waitForTimeout(1_300);
  assert.equal((await publications()).length, 2);

  const cases = [
    {
      name: 'later unrelated user message',
      html: '<div data-virtual-list-item-key="-31"><div class="ds-message">Paired question</div></div><div data-virtual-list-item-key="31"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div></div><div data-virtual-list-item-key="-999"><div class="ds-message">Later unrelated question</div></div>',
      expected: 'Paired question'
    },
    {
      name: 'single-turn missing key fallback',
      html: '<div><div class="ds-message">Question without key</div></div><div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div></div>',
      expected: 'Question without key'
    },
    {
      name: 'duplicate matching candidates',
      html: '<div data-virtual-list-item-key="-41"><div class="ds-message">Earlier duplicate</div></div><div data-virtual-list-item-key="-41"><div class="ds-message">Immediate duplicate</div></div><div data-virtual-list-item-key="41"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div></div>',
      expected: ''
    },
    {
      name: 'single-turn malformed key fallback',
      html: '<div data-virtual-list-item-key="-bad"><div class="ds-message">Malformed question</div></div><div data-virtual-list-item-key="bad"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div></div>',
      expected: 'Malformed question'
    },
    {
      name: 'non-adjacent matching candidate',
      html: '<div data-virtual-list-item-key="-53"><div class="ds-message">Too early question</div></div><div data-virtual-list-item-key="-777"><div class="ds-message">Intervening message</div></div><div data-virtual-list-item-key="53"><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div></div>',
      expected: ''
    }
  ];
  for (const scenario of cases) {
    await page.evaluate((html) => { document.body.innerHTML = html; }, scenario.html);
    const result = await page.evaluate(() => globalThis.__AI_GEO_DEEPSEEK_SPIKE__.capture());
    assert.equal(result.question, scenario.expected, scenario.name);
  }
});

test('Unified DeepSeek single-turn Question fallback remains unambiguous and deduped', async (t) => {
  const { browser, page, publications } = await unifiedDeepSeekFixture(`
    <div class="ds-message">Single monitoring query<button>excluded control</button></div>
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Single answer <a href="https://source.example/a"><span class="ds-markdown-cite">1</span></a></div><div>已阅读 5 个网页</div></div>
  `);
  t.after(() => browser.close());

  await waitForDeepSeekPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.question, 'Single monitoring query');
  assert.equal(first.result.conversation_url, 'https://chat.deepseek.com/a/chat/s/fixture-conversation');
  assert.equal(first.result.question.includes('excluded control'), false);
  assert.equal(first.result.answer, 'Single answer 1');
  assert.equal(first.result.answer_html.includes('Single answer'), true);
  assert.deepEqual(first.result.citation_occurrences, [{ position: 1, url: 'https://source.example/a' }]);
  assert.equal(first.result.platform_reported_source_count, 5);
  await page.waitForTimeout(1_300);
  assert.equal((await publications()).length, 1);

  const ambiguousCases = [
    {
      name: 'two user messages and one assistant without strong pairing',
      html: '<div class="ds-message">First question</div><div class="ds-message">Second question</div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div>'
    },
    {
      name: 'one user message and two assistants without strong pairing',
      html: '<div class="ds-message">Question</div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">First answer</div></div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Second answer</div></div>'
    },
    {
      name: 'empty question after control removal',
      html: '<div class="ds-message"><button>Only control</button></div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Answer</div></div>'
    }
  ];
  for (const scenario of ambiguousCases) {
    await page.evaluate((html) => { document.body.innerHTML = html; }, scenario.html);
    const result = await page.evaluate(() => globalThis.__AI_GEO_DEEPSEEK_SPIKE__.capture());
    assert.equal(result.question, '', scenario.name);
  }
});

test('Unified DeepSeek preserves only a strict current official conversation URL', async (t) => {
  const { browser, page, publications } = await unifiedDeepSeekFixture(`
    <div class="ds-message">Single monitoring query</div>
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">Single answer <a href="https://source.example/a"><span class="ds-markdown-cite">1</span></a></div><div>已阅读 5 个网页</div></div>
  `, 'https://chat.deepseek.com/a/chat/s/first-fixture-id');
  t.after(() => browser.close());

  await waitForDeepSeekPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.conversation_url, 'https://chat.deepseek.com/a/chat/s/first-fixture-id');
  assert.equal(first.result.question, 'Single monitoring query');
  assert.equal(first.result.answer, 'Single answer 1');
  assert.equal(first.result.answer_html.includes('Single answer'), true);
  assert.deepEqual(first.result.citation_occurrences, [{ position: 1, url: 'https://source.example/a' }]);
  assert.equal(first.result.platform_reported_source_count, 5);
  await page.waitForTimeout(1_300);
  assert.equal((await publications()).length, 1);

  await page.evaluate(() => {
    history.pushState({}, '', '/a/chat/s/second-fixture-id');
    document.body.append(document.createComment('conversation-url-change'));
  });
  await waitForDeepSeekPublications(page, publications, 2);
  const changed = (await publications())[1];
  assert.equal(changed.result.conversation_url, 'https://chat.deepseek.com/a/chat/s/second-fixture-id');
  assert.equal(changed.result.question, first.result.question);
  assert.equal(changed.result.answer, first.result.answer);
  assert.equal(changed.result.answer_html, first.result.answer_html);
  assert.deepEqual(changed.result.citation_occurrences, first.result.citation_occurrences);
  assert.equal(changed.result.platform_reported_source_count, first.result.platform_reported_source_count);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  const invalidUrls = [
    undefined,
    'https://chat.deepseek.com/',
    'https://chat.deepseek.com/a/chat',
    'https://chat.deepseek.com/a/chat/s/',
    'https://chat.deepseek.com/a/chat/s/first/extra',
    'https://example.test/a/chat/s/first-fixture-id',
    'http://chat.deepseek.com/a/chat/s/first-fixture-id'
  ];
  for (const href of invalidUrls) {
    assert.equal(deepSeekLocationOnlyCapture(href).conversation_url, '', String(href));
  }
});

test('Yuanbao preserves its frozen MAIN observer and isolated adapter boundary', () => {
  const mainEntry = manifest.content_scripts.find((candidate) => candidate.world === 'MAIN' && candidate.matches.includes('https://yuanbao.tencent.com/*'));
  const adapterEntry = manifest.content_scripts.find((candidate) => candidate.js.includes('platforms/yuanbao/content.js'));
  assert.ok(mainEntry);
  assert.deepEqual(mainEntry.js, ['platforms/yuanbao/page-response-observer.js']);
  assert.equal(mainEntry.run_at, 'document_start');
  assert.ok(adapterEntry);
  assert.deepEqual(adapterEntry.matches, ['https://yuanbao.tencent.com/*']);
  assert.equal(adapterEntry.world, undefined);
  assert.match(yuanbaoProbeSource, /originalFetch/);
  assert.match(yuanbaoProbeSource, /XMLHttpRequest/);
  assert.match(yuanbaoProbeSource, /__AI_GEO_YUANBAO_POC_RESPONSE__/);
  assert.match(yuanbaoContentSource, /PROCESSING_ROOT_SELECTOR/);
  assert.match(yuanbaoContentSource, /rawAcquisitionSnapshot/);
  assert.match(yuanbaoContentSource, /structured_processing/);
  assert.match(yuanbaoContentSource, /__AI_GEO_UNIFIED_EXTENSION_RUNTIME__/);
  assert.match(yuanbaoContentSource, /publishUnifiedObservation\(result\)/);
  assert.equal(mainEntry.matches[0], 'https://yuanbao.tencent.com/*');
  assert.equal(mainEntry.matches.some((match) => match.includes('doubao') || match.includes('deepseek')), false);
  assert.equal(adapterEntry.js.some((script) => script.includes('doubao') || script.includes('deepseek')), false);
});

test('Yuanbao routes raw-only and full observations through one unified publication boundary', () => {
  const publishCalls = yuanbaoContentSource.match(/publishObservation\(/g) || [];
  assert.equal(publishCalls.length, 1);
  assert.match(yuanbaoContentSource, /function publishUnifiedObservation\(result\)/);
  assert.match(yuanbaoContentSource, /function publishResult\(result\)[\s\S]*publishUnifiedObservation\(result\)/);
  assert.match(yuanbaoContentSource, /global\.__AI_GEO_YUANBAO_POC_LAST_RESULT__ = rawOnlyResult\(\);[\s\S]*publishResult\(global\.__AI_GEO_YUANBAO_POC_LAST_RESULT__\)/);
  assert.match(yuanbaoContentSource, /global\.__AI_GEO_YUANBAO_POC_LAST_RESULT__ = lastResult;[\s\S]*publishResult\(lastResult\)/);
  assert.match(yuanbaoContentSource, /const fingerprintSource = \{ \.\.\.result \};/);
  assert.match(yuanbaoContentSource, /delete fingerprintSource\.captured_at;/);
  assert.doesNotMatch(yuanbaoContentSource, /semanticFingerprint = JSON\.stringify\(\{/);
});

async function unifiedYuanbaoFixture(html, url = 'https://yuanbao.tencent.com/chat/fixture-a/fixture-b?enter_type=sidebar_dialog') {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(() => {
    globalThis.__AI_GEO_TEST_PUBLICATIONS__ = [];
    globalThis.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__ = {
      activatePlatform: () => ({
        publishObservation: (result, fingerprint) => globalThis.__AI_GEO_TEST_PUBLICATIONS__.push({ result, fingerprint })
      })
    };
  });
  await page.addScriptTag({ content: yuanbaoContentSource });
  return { browser, page, publications: () => page.evaluate(() => globalThis.__AI_GEO_TEST_PUBLICATIONS__) };
}

async function waitForYuanbaoPublications(page, publications, count) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await publications()).length >= count) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${count} Yuanbao publication(s).`);
}

test('Unified Yuanbao captures only an unambiguous single-turn human Prompt', async (t) => {
  const { browser, page, publications } = await unifiedYuanbaoFixture(`
    <div data-conv-speaker="human">Single monitoring query<button>excluded control</button></div>
    <div data-conv-speaker="ai" data-conv-outputting="false">Single answer</div>
  `);
  t.after(() => browser.close());

  await waitForYuanbaoPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.prompt, 'Single monitoring query');
  assert.equal(first.result.prompt.includes('excluded control'), false);
  assert.equal(first.result.response.attributes['data-conv-speaker'], 'ai');
  assert.equal(first.result.processing_trace, 'absent');
  assert.equal(first.result.structured_processing, null);
  assert.equal(first.result.raw_acquisition.status, 'not_observed');
  assert.equal(first.result.page_url, 'https://yuanbao.tencent.com/chat/fixture-a/fixture-b?enter_type=sidebar_dialog');
  assert.equal(first.result.conversation_url, first.result.page_url);
  await page.waitForTimeout(500);
  assert.equal((await publications()).length, 1);

  await page.evaluate(() => {
    document.querySelector('[data-conv-speaker="human"]').firstChild.textContent = 'Changed monitoring query';
  });
  await waitForYuanbaoPublications(page, publications, 2);
  const changed = (await publications())[1];
  assert.equal(changed.result.prompt, 'Changed monitoring query');
  assert.notEqual(changed.fingerprint, first.fingerprint);

  const unsupportedCases = [
    { name: 'human after selected ai', html: '<div data-conv-speaker="ai" data-conv-outputting="false">Answer</div><div data-conv-speaker="human">Late prompt</div>' },
    { name: 'no human', html: '<div data-conv-speaker="ai" data-conv-outputting="false">Answer</div>' },
    { name: 'multiple humans', html: '<div data-conv-speaker="human">First prompt</div><div data-conv-speaker="human">Second prompt</div><div data-conv-speaker="ai" data-conv-outputting="false">Answer</div>' },
    { name: 'unsupported multi-turn', html: '<div data-conv-speaker="human">First prompt</div><div data-conv-speaker="ai" data-conv-outputting="false">First answer</div><div data-conv-speaker="human">Second prompt</div><div data-conv-speaker="ai" data-conv-outputting="false">Second answer</div>' },
    { name: 'empty prompt', html: '<div data-conv-speaker="human"><button>Only control</button></div><div data-conv-speaker="ai" data-conv-outputting="false">Answer</div>' },
    { name: 'malformed speaker structure', html: '<div data-conv-speaker="human">Prompt</div><div data-conv-speaker="other">Unexpected</div><div data-conv-speaker="ai" data-conv-outputting="false">Answer</div>' }
  ];
  for (const scenario of unsupportedCases) {
    await page.evaluate((html) => { document.body.innerHTML = html; }, scenario.html);
    await page.waitForTimeout(300);
    const latest = (await publications()).at(-1);
    assert.equal(latest.result.prompt, '', scenario.name);
  }
});

test('Unified Yuanbao preserves only a strict current official conversation URL', async (t) => {
  const fixtureHtml = '<div data-conv-speaker="human">Single monitoring query</div><div data-conv-speaker="ai" data-conv-outputting="false">Single answer</div>';
  const { browser, page, publications } = await unifiedYuanbaoFixture(fixtureHtml, 'https://yuanbao.tencent.com/chat/first-fixture/second-fixture?enter_type=sidebar_dialog');
  t.after(() => browser.close());

  await waitForYuanbaoPublications(page, publications, 1);
  const first = (await publications())[0];
  assert.equal(first.result.page_url, 'https://yuanbao.tencent.com/chat/first-fixture/second-fixture?enter_type=sidebar_dialog');
  assert.equal(first.result.conversation_url, first.result.page_url);
  assert.equal(first.result.prompt, 'Single monitoring query');
  assert.equal(first.result.response.attributes['data-conv-speaker'], 'ai');
  assert.equal(first.result.processing_trace, 'absent');
  assert.equal(first.result.structured_processing, null);
  assert.equal(first.result.raw_acquisition.status, 'not_observed');
  await page.waitForTimeout(500);
  assert.equal((await publications()).length, 1);

  await page.evaluate(() => {
    history.pushState({}, '', '/chat/different-first/different-second?enter_type=sidebar_dialog');
    document.body.append(document.createComment('conversation-url-change'));
  });
  await waitForYuanbaoPublications(page, publications, 2);
  const changed = (await publications())[1];
  assert.equal(changed.result.page_url, 'https://yuanbao.tencent.com/chat/different-first/different-second?enter_type=sidebar_dialog');
  assert.equal(changed.result.conversation_url, changed.result.page_url);
  assert.equal(changed.result.prompt, first.result.prompt);
  assert.deepEqual(changed.result.response, first.result.response);
  assert.equal(changed.result.processing_trace, first.result.processing_trace);
  assert.deepEqual(changed.result.structured_processing, first.result.structured_processing);
  assert.deepEqual(changed.result.raw_acquisition, first.result.raw_acquisition);
  assert.notEqual(changed.fingerprint, first.fingerprint);

  const invalidPaths = ['/', '/explore', '/chat/only-one', '/chat/a/', '/chat/a/b/c'];
  for (const path of invalidPaths) {
    const expectedCount = (await publications()).length + 1;
    await page.evaluate((nextPath) => {
      history.pushState({}, '', nextPath);
      document.body.append(document.createComment('invalid-conversation-url'));
    }, path);
    await waitForYuanbaoPublications(page, publications, expectedCount);
    const latest = (await publications()).at(-1);
    assert.equal(latest.result.conversation_url, '', path);
    assert.equal(latest.result.page_url, new URL(path, 'https://yuanbao.tencent.com').href, path);
  }

  for (const href of ['https://example.test/chat/a/b', 'http://yuanbao.tencent.com/chat/a/b']) {
    const invalid = await unifiedYuanbaoFixture(fixtureHtml, href);
    try {
      await waitForYuanbaoPublications(invalid.page, invalid.publications, 1);
      const result = (await invalid.publications())[0].result;
      assert.equal(result.conversation_url, '', href);
      assert.equal(result.page_url, href, href);
    } finally {
      await invalid.browser.close();
    }
  }
});

for (const [host, id] of [
  ['https://www.doubao.com/chat/1', 'doubao'],
  ['https://yuanbao.tencent.com/chat/1', 'yuanbao'],
  ['https://chat.deepseek.com/a', 'deepseek']
  ,['https://wenxin.baidu.com/search/1', 'wenxin']
]) {
  test(`exact router resolves ${id} only`, () => {
    const context = loadRuntime(host);
    assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform().id, id);
    const session = context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__.activatePlatform(id);
    assert.equal(session.descriptor.id, id);
    assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__.platform_id, id);
  });
}

test('unsupported and similar or evil hosts fail closed', () => {
  const context = loadRuntime('https://www.doubao.com.evil.test/chat/1');
  assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform(), null);
  assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__.activatePlatform('doubao'), null);
  assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__.adapter_status, 'inactive');
  for (const url of ['http://www.doubao.com/', 'https://doubao.com/', 'https://yuanbao.tencent.com.evil.test/']) {
    assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform(url), null);
  }
});

test('one URL cannot resolve to multiple platforms', () => {
  const context = loadRuntime('https://www.doubao.com/');
  const matches = context.__AI_GEO_UNIFIED_PLATFORM_REGISTRY__.filter((entry) => entry.exact_hosts.includes('www.doubao.com'));
  assert.equal(matches.length, 1);
  assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform().id, 'doubao');
});

test('adding a fake descriptor requires no router branch and preserves fail-closed behavior', () => {
  const context = loadRuntime('https://example.test/chat');
  const api = context.__AI_GEO_UNIFIED_PLATFORM_REGISTRY_API__;
  const extended = api.createPlatformRegistry([
    ...context.__AI_GEO_UNIFIED_PLATFORM_REGISTRY__,
    { id: 'fake', exact_hosts: ['example.test'], bootstrap_script: 'platforms/fake/bootstrap.js', injection: { content_world: 'ISOLATED' }, capability: { status: 'skeleton_only' } }
  ]);
  assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform('https://example.test/chat', extended).id, 'fake');
  assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform('https://example.test.evil/'), null);
  assert.equal(context.__AI_GEO_UNIFIED_PLATFORM_ROUTER__.resolvePlatform('https://www.doubao.com/', extended).id, 'doubao');
});

test('publication boundary accepts plain data and dedupes same fingerprint in memory', () => {
  const context = loadRuntime('https://www.doubao.com/');
  const runtime = context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__;
  const sink = runtime.activatePlatform('doubao');
  assert.equal(sink.publishObservation({ value: 1 }, 'abc'), true);
  assert.equal(sink.publishObservation({ value: 2 }, 'abc'), false);
  assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__.publish_count, 1);
  assert.equal(sink.publishObservation({ value: 3 }, 'def'), true);
  assert.equal(context.__AI_GEO_UNIFIED_EXTENSION_RUNTIME_STATUS__.publish_count, 2);
});
