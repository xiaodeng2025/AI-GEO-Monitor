import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  DEEPSEEK_FINAL_ANSWER_SELECTOR,
  DEEPSEEK_RESPONSE_ROOT_SELECTOR,
  DeepSeekAdapter
} from '../src/platforms/deepseek/deepseek-adapter.js';

async function fixturePage(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

test('DeepSeek locates only a response newer than the baseline and its final Markdown', async (t) => {
  const { browser, page } = await fixturePage(`
    <a href="https://ordinary.example/navigation">navigation</a>
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">old</div></div>
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">new answer</div></div>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  const root = await adapter.locateResponseRoot({ count: 1, lastFingerprint: 'old-fingerprint' });
  assert.ok(root);
  assert.equal(await root.locator(DEEPSEEK_FINAL_ANSWER_SELECTOR).innerText(), 'new answer');
  assert.equal(await page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR).count(), 2);
});

test('DeepSeek captures ordered Citation occurrences from parent anchors and preserves duplicate URLs', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="ds-message">
      <div class="ds-markdown ds-assistant-message-main-content">
        <p>第一段 <a href="https://source.example/a"><span class="ds-markdown-cite">1</span></a></p>
        <p><a href="https://ordinary.example/body">普通正文链接</a></p>
        <p>第二段 <a href="https://source.example/b"><span class="ds-markdown-cite">2</span></a>
        <a href="https://source.example/a"><span class="ds-markdown-cite">3</span></a></p>
      </div>
      <div class="pool">已阅读 8 个网页</div>
    </div>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  const result = await adapter.extractCitations(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR));
  assert.equal(result.status, 'captured');
  assert.deepEqual(await adapter.observeSourcePool(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR)), { platform_reported_source_count: 8 });
  assert.deepEqual(result.citations, [
    { position: 1, link_url: 'https://source.example/a', title: null, display_domain: null, association_method: 'trigger_bound' },
    { position: 2, link_url: 'https://source.example/b', title: null, display_domain: null, association_method: 'trigger_bound' },
    { position: 3, link_url: 'https://source.example/a', title: null, display_domain: null, association_method: 'trigger_bound' }
  ]);
});

test('DeepSeek keeps a source-pool count separate when no formal Citation is present', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">
      <p>只有普通链接 <a href="https://ordinary.example/body">正文链接</a></p>
      <div>已阅读 8 个网页</div>
    </div></div>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  const result = await adapter.extractCitations(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR));
  assert.equal(result.status, 'not_displayed');
  assert.deepEqual(result.citations, []);
  assert.deepEqual(await adapter.observeSourcePool(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR)), { platform_reported_source_count: 8 });
});

test('DeepSeek accepts the standalone source-pool count label without promoting it to Citation', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">回答</div><div>8 个网页</div></div>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  const result = await adapter.extractCitations(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR));
  assert.equal(result.status, 'not_displayed');
  assert.deepEqual(await adapter.observeSourcePool(page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR)), { platform_reported_source_count: 8 });
  assert.deepEqual(result.citations, []);
});

test('DeepSeek completion requires non-empty final Markdown and a one-second stable window', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">稳定回答</div></div>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  await adapter.waitForResponse({ count: 0, lastFingerprint: null }, 3_000);
});

test('DeepSeek completion may exceed the safety window while final-answer text keeps progressing', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">进展一</div><div aria-busy="true"></div></div>
    <script>
      const root = document.querySelector('.ds-message');
      const answer = root.querySelector('.ds-assistant-message-main-content');
      let step = 1;
      const timer = setInterval(() => { step += 1; answer.textContent = '进展' + step; if (step === 4) { clearInterval(timer); setTimeout(() => root.querySelector('[aria-busy]').remove(), 100); } }, 400);
    </script>
  `);
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  await adapter.waitForResponse({ count: 0, lastFingerprint: null }, 1_800);
});

test('DeepSeek safety termination still occurs when no observable response progress exists', async (t) => {
  const { browser, page } = await fixturePage('<div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content"></div><div aria-busy="true"></div></div>');
  t.after(() => browser.close());
  const adapter = new DeepSeekAdapter(page);
  await assert.rejects(() => adapter.waitForResponse({ count: 0, lastFingerprint: null }, 200), (error) => error.code === 'ANSWER_TIMEOUT');
});
