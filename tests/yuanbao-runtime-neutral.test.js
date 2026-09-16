import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { YuanbaoPlaywrightSession } from '../src/runtime/playwright/yuanbao-playwright-session.js';
import { YuanbaoAdapter } from '../src/platforms/yuanbao/yuanbao-adapter.js';

test('Yuanbao session returns independent observation and Citation data without popup handles', async () => {
  const page = { runtimeOnly: 'page' };
  const responseRoot = { runtimeOnly: 'response' };
  const answerHandle = { runtimeOnly: 'answer' };
  const stalePopupHandle = { runtimeOnly: 'remounted-popup' };
  let answerHandleReceived;
  let citationHandleReceived;
  const adapter = {
    async startFreshChat() {},
    async captureBaseline() { return { responseRootCount: 0 }; },
    async submitPrompt() {},
    async waitForResponse() {},
    async locateResponseRoot() { return responseRoot; },
    async extractAnswer() { return { text: 'Yuanbao answer', fingerprint: 'yuanbao-answer', evidenceRoot: answerHandle }; },
    async observeSourcePool() { return { platform_reported_source_count: 17 }; },
    async extractCitations() {
      return {
        status: 'captured',
        citations: [
          { position: 1, trigger_position: 1, source_position: 1, source_index: '1', title: 'Source A', link_url: 'https://source.example/a', display_domain: null, source_site: 'Example', association_method: 'trigger_bound' },
          { position: 1, trigger_position: 1, source_position: 2, source_index: '1', title: 'Source A again', link_url: 'https://source.example/a', display_domain: null, source_site: 'Example', association_method: 'trigger_bound' }
        ],
        panel: stalePopupHandle
      };
    }
  };
  const provider = {
    async materializeAnswer(input) {
      answerHandleReceived = input.handle;
      return { answer: { text: input.text, html: '<div>Yuanbao answer</div>', fingerprint: input.fingerprint }, artifacts: [] };
    },
    async materializeCitationEvidence(input) {
      citationHandleReceived = input.handle;
      throw new Error('popup remounted before supplementary capture');
    },
    async materializeFailure() { return []; }
  };
  const session = new YuanbaoPlaywrightSession({
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
  assert.equal(citationHandleReceived, stalePopupHandle);
  assert.equal(result.observation.platform_reported_source_count, 17);
  assert.deepEqual(result.citations, {
    status: 'captured',
    citations: [
      { position: 1, trigger_position: 1, source_position: 1, source_index: '1', title: 'Source A', link_url: 'https://source.example/a', display_domain: null, source_site: 'Example', association_method: 'trigger_bound' },
      { position: 1, trigger_position: 1, source_position: 2, source_index: '1', title: 'Source A again', link_url: 'https://source.example/a', display_domain: null, source_site: 'Example', association_method: 'trigger_bound' }
    ]
  });
  assert.deepEqual(result.artifacts, { answer: [], citation: [] });
  assert.equal('evidenceRoot' in result, false);
  assert.equal('panel' in result, false);
});

test('Yuanbao session returns replay diagnostics as a plain artifact', async () => {
  const page = { runtimeOnly: 'page' };
  const responseRoot = { runtimeOnly: 'response' };
  const answerHandle = { runtimeOnly: 'answer' };
  const diagnostics = {
    scope: 'accepted_response',
    trigger_count: 1,
    triggers: [{ trigger_position: 1, failure_stage: 'card_reacquire', failure_reason: 'card_data_idx_not_changed' }],
    first_failure: { trigger_position: 1, expected_idx: '2', stage: 'card_reacquire' },
    parsed_citations: []
  };
  let receivedDiagnostics;
  const adapter = {
    async startFreshChat() {},
    async captureBaseline() { return { responseRootCount: 0 }; },
    async submitPrompt() {},
    async waitForResponse() {},
    async locateResponseRoot() { return responseRoot; },
    async extractAnswer() { return { text: 'Yuanbao answer', fingerprint: 'answer', evidenceRoot: answerHandle }; },
    async observeSourcePool() { return { platform_reported_source_count: 32 }; },
    async extractCitations() { return { status: 'parse_failed', citations: [], diagnostics }; }
  };
  const provider = {
    async materializeAnswer(input) { return { answer: { text: input.text, html: '<div>answer</div>', fingerprint: input.fingerprint }, artifacts: [] }; },
    async materializeCitationReplayDiagnostics(input) {
      receivedDiagnostics = input;
      return [{ kind: 'citation_replay_diagnostics', fileName: 'citation-replay-diagnostics.json', content: JSON.stringify(input) }];
    },
    async materializeFailure() { return []; }
  };
  const session = new YuanbaoPlaywrightSession({
    runtime: { async newPage() { return page; }, async close() {} },
    evidenceProvider: provider,
    adapterFactory: (candidate) => { assert.equal(candidate, page); return adapter; }
  });

  const result = await session.run({ promptText: 'question', timeoutMs: 1000 });

  assert.deepEqual(receivedDiagnostics, diagnostics);
  assert.deepEqual(result.citations, { status: 'parse_failed', citations: [] });
  assert.deepEqual(result.artifacts.citation, [{
    kind: 'citation_replay_diagnostics',
    fileName: 'citation-replay-diagnostics.json',
    content: JSON.stringify(diagnostics)
  }]);
  assert.equal('diagnostics' in result.citations, false);
});

test('Yuanbao completion may exceed the safety window while lifecycle text keeps progressing', async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent(`
    <div data-conv-speaker="ai" data-conv-outputting="true"><div class="hyc-content-md-done"></div></div>
    <script>
      const root = document.querySelector('[data-conv-speaker="ai"]');
      const answer = root.querySelector('.hyc-content-md-done');
      let step = 0;
      const timer = setInterval(() => { step += 1; answer.textContent = '进展' + step; if (step === 4) { clearInterval(timer); root.dataset.convOutputting = 'false'; } }, 250);
    </script>
  `);
  const adapter = new YuanbaoAdapter(page);
  await adapter.waitForResponse({ responseRootCount: 0 }, 1_500);
});

test('Yuanbao safety termination still occurs when no observable response progress exists', async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent('<div data-conv-speaker="ai" data-conv-outputting="true"><div class="hyc-content-md-done"></div></div>');
  const adapter = new YuanbaoAdapter(page);
  await assert.rejects(() => adapter.waitForResponse({ responseRootCount: 0 }, 200), (error) => error.code === 'ANSWER_TIMEOUT');
});
