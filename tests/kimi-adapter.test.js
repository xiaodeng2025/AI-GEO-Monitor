import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { anyVisible, KimiAdapter } from '../src/platforms/kimi/kimi-adapter.js';

async function fixturePage(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

test('Kimi adapter accepts a new response from a response baseline and ignores a page-wide navigation link', async (t) => {
  const { browser, page } = await fixturePage(`
    <a href="https://unrelated.example/nav">navigation</a>
    <div class="segment segment-assistant">previous answer</div>
    <div class="segment segment-assistant">new answer <span class="citation"><a href="https://source.example/a">Source A</a></span></div>
  `);
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  const response = await adapter.locateResponseRoot({ count: 1, lastFingerprint: 'old' });
  assert.ok(response);
  assert.match(await response.innerText(), /new answer/);
  const citations = await adapter.extractCitations(response);
  assert.equal(citations.status, 'captured');
  assert.deepEqual(citations.citations, [{ position: 1, title: 'Source A', link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' }]);
});

test('Kimi adapter captures contained pua Citation instances in DOM order without URL deduplication', async (t) => {
  const { browser, page } = await fixturePage(`
    <a href="https://unrelated.example/nav">navigation</a>
    <div class="segment segment-assistant">
      <div class="markdown-container toolcall-content-text">
        <a href="https://retrieval.example/one">搜索网页结果</a>
        <a href="https://retrieval.example/two">搜索网页结果</a>
      </div>
      <div class="markdown-container"><div class="markdown">
        <p>段落一<a class="pua-ref-cite-tag pua-ref-cite-tag--text" href="https://example.com/a" data-site-name="Example A"></a></p>
        <p>段落二<a class="pua-ref-cite-tag pua-ref-cite-tag--text" href="https://example.com/b" data-site-name="Example B"></a></p>
        <p>段落三<a class="pua-ref-cite-tag pua-ref-cite-tag--text" href="https://example.com/a" data-site-name="Example A"></a></p>
        <p><a href="https://ordinary.example.com">普通正文链接</a></p>
      </div></div>
    </div>
  `);
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  const citations = await adapter.extractCitations(page.locator('.segment.segment-assistant'));
  assert.equal(citations.status, 'captured');
  assert.deepEqual(citations.citations, [
    { position: 1, title: null, link_url: 'https://example.com/a', display_domain: null, association_method: 'contained' },
    { position: 2, title: null, link_url: 'https://example.com/b', display_domain: null, association_method: 'contained' },
    { position: 3, title: null, link_url: 'https://example.com/a', display_domain: null, association_method: 'contained' }
  ]);
});

test('Kimi adapter accepts only a panel opened by the response-local source trigger', async (t) => {
  const { browser, page } = await fixturePage(`
    <a href="https://unrelated.example/nav">navigation</a>
    <div class="segment segment-assistant">answer <button id="citation-trigger" aria-controls="source-panel">引用来源</button></div>
    <div id="source-panel" class="source-panel" style="display:none"><a href="https://source.example/b">Source B</a></div>
    <script>document.querySelector('#citation-trigger').onclick = () => document.querySelector('#source-panel').style.display = 'block';</script>
  `);
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  const response = page.locator('.segment.segment-assistant');
  const citations = await adapter.extractCitations(response);
  assert.equal(citations.status, 'captured');
  assert.deepEqual(citations.citations, [{ position: 1, title: 'Source B', link_url: 'https://source.example/b', display_domain: null, association_method: 'trigger_bound' }]);
});

test('Kimi adapter extracts final Markdown but excludes thinking and search toolcall text', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="segment segment-assistant">
      <div class="markdown-container toolcall-content-text"><div class="markdown">思考已完成 搜索网页 50 个结果</div></div>
      <div class="markdown-container"><div class="markdown">这是最终回答。</div></div>
    </div>
  `);
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  const answer = await adapter.extractAnswer(page.locator('.segment.segment-assistant'));
  assert.equal(answer.text, '这是最终回答。');
  assert.doesNotMatch(answer.text, /搜索网页/);
  assert.ok(answer.evidenceRoot);
});

test('generation remains active when any later stop control is visible', async (t) => {
  const { browser, page } = await fixturePage(`
    <button class="stop-button" style="display:none">停止生成</button>
    <button class="stop-button">停止生成</button>
  `);
  t.after(() => browser.close());
  assert.equal(await anyVisible(page.locator('.stop-button')), true);
});

test('Kimi completion may exceed the safety window while final-answer text keeps progressing', async (t) => {
  const { browser, page } = await fixturePage(`
    <button class="stop-button">停止生成</button>
    <div class="segment segment-assistant"><div class="markdown-container"><div class="markdown">进展一</div></div></div>
    <script>
      const answer = document.querySelector('.markdown');
      let step = 1;
      const timer = setInterval(() => { step += 1; answer.textContent = '进展' + step; if (step === 4) { clearInterval(timer); setTimeout(() => document.querySelector('.stop-button').style.display = 'none', 100); } }, 400);
    </script>
  `);
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  await adapter.waitForResponse({ count: 0, lastFingerprint: null }, 3_500);
});

test('Kimi safety termination still occurs when no observable response progress exists', async (t) => {
  const { browser, page } = await fixturePage('<button class="stop-button">停止生成</button>');
  t.after(() => browser.close());
  const adapter = new KimiAdapter(page);
  await assert.rejects(() => adapter.waitForResponse({ count: 0, lastFingerprint: null }, 200), (error) => error.code === 'ANSWER_TIMEOUT');
});
