import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { KimiAdapter } from '../src/platforms/kimi/kimi-adapter.js';
import { KimiPlaywrightSession } from '../src/runtime/playwright/kimi-playwright-session.js';
import { PlaywrightEvidenceProvider } from '../src/runtime/playwright/playwright-evidence-provider.js';

async function fixturePage(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

test('Kimi final answer and contained duplicate Citations materialize through the provider', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="segment segment-assistant">
      <div class="markdown-container toolcall-content-text"><div class="markdown">搜索网页 50 个结果</div></div>
      <div class="markdown-container"><div class="markdown">
        <p>最终回答<a class="pua-ref-cite-tag" href="https://source.example/a" data-site-name="Source A"></a></p>
        <p>再次引用<a class="pua-ref-cite-tag" href="https://source.example/a" data-site-name="Source A"></a></p>
      </div></div>
    </div>
  `);
  t.after(() => browser.close());

  const adapter = new KimiAdapter(page);
  const provider = new PlaywrightEvidenceProvider();
  const root = page.locator('.segment.segment-assistant');
  const answerObservation = await adapter.extractAnswer(root);
  const answer = await provider.materializeAnswer({
    handle: answerObservation.evidenceRoot,
    text: answerObservation.text,
    fingerprint: answerObservation.fingerprint
  });
  const citationCapture = await adapter.extractCitations(root);
  const citationArtifacts = await provider.materializeCitationEvidence({ handle: citationCapture.panel });

  assert.equal(answer.answer.text, '最终回答 再次引用');
  assert.doesNotMatch(answer.answer.html, /搜索网页/);
  assert.deepEqual(citationCapture.citations, [
    { position: 1, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' },
    { position: 2, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' }
  ]);
  assert.deepEqual(citationArtifacts.map(({ kind }) => kind), ['citations_html']);
  assert.equal('evidenceRoot' in answer.answer, false);
  assert.equal('panel' in answer, false);
});

test('Kimi zero-Citation output remains a valid plain result', async (t) => {
  const { browser, page } = await fixturePage(`
    <div class="segment segment-assistant">
      <div class="markdown-container"><div class="markdown">没有正式引用。</div></div>
    </div>
  `);
  t.after(() => browser.close());

  const citations = await new KimiAdapter(page).extractCitations(page.locator('.segment.segment-assistant'));
  assert.deepEqual(citations, { status: 'not_displayed', citations: [] });
});

test('Kimi session keeps semantic Citations when supplementary capture fails and returns no handles', async () => {
  const page = { runtimeOnly: 'page' };
  const responseRoot = { runtimeOnly: 'response' };
  const answerHandle = { runtimeOnly: 'answer' };
  const citationPanel = { runtimeOnly: 'panel' };
  let answerHandleReceived;
  let citationHandleReceived;
  const adapter = {
    async startFreshChat() {},
    async captureBaseline() { return { runtimeNeutral: true }; },
    async submitPrompt() {},
    async waitForResponse() {},
    async locateResponseRoot() { return responseRoot; },
    async extractAnswer() { return { text: 'Kimi answer', fingerprint: 'kimi-answer', evidenceRoot: answerHandle }; },
    async extractCitations() {
      return {
        status: 'captured',
        citations: [
          { position: 1, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' },
          { position: 2, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' }
        ],
        panel: citationPanel
      };
    }
  };
  const provider = {
    async materializeAnswer(input) {
      answerHandleReceived = input.handle;
      return { answer: { text: input.text, html: '<p>Kimi answer</p>', fingerprint: input.fingerprint }, artifacts: [] };
    },
    async materializeCitationEvidence(input) {
      citationHandleReceived = input.handle;
      throw new Error('supplementary capture unavailable');
    },
    async materializeFailure() { return []; }
  };
  const session = new KimiPlaywrightSession({
    runtime: {
      async newPage() { return page; },
      async close() {}
    },
    evidenceProvider: provider,
    adapterFactory: (candidate) => {
      assert.equal(candidate, page);
      return adapter;
    }
  });

  const result = await session.run({ promptText: 'question', timeoutMs: 1000 });
  assert.equal(answerHandleReceived, answerHandle);
  assert.equal(citationHandleReceived, citationPanel);
  assert.deepEqual(result.citations, {
    status: 'captured',
    citations: [
      { position: 1, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' },
      { position: 2, title: null, link_url: 'https://source.example/a', display_domain: null, association_method: 'contained' }
    ]
  });
  assert.deepEqual(result.observation, { platform_reported_source_count: null });
  assert.deepEqual(result.artifacts, { answer: [], citation: [] });
  assert.equal('evidenceRoot' in result, false);
  assert.equal('panel' in result, false);
});
