import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaywrightEvidenceProvider } from '../src/runtime/playwright/playwright-evidence-provider.js';

test('PlaywrightEvidenceProvider converts a runtime handle into plain answer evidence and bytes', async () => {
  const provider = new PlaywrightEvidenceProvider();
  const handle = {
    async evaluate(readOuterHtml) { return readOuterHtml({ outerHTML: '<article>answer</article>' }); }
  };
  const result = await provider.materializeAnswer({ handle, text: 'answer', fingerprint: 'answer-fingerprint' });

  assert.deepEqual(result.answer, {
    text: 'answer', html: '<article>answer</article>', fingerprint: 'answer-fingerprint'
  });
  assert.equal('handle' in result.answer, false);
  assert.deepEqual(result.artifacts.map(({ kind, fileName, content }) => ({ kind, fileName, content: content.toString() })), [
    { kind: 'answer_html', fileName: 'answer.html', content: '<article>answer</article>' }
  ]);
});

test('PlaywrightEvidenceProvider captures a completion-context viewport screenshot without using a locator screenshot', async () => {
  const provider = new PlaywrightEvidenceProvider();
  const calls = [];
  const artifacts = await provider.materializeTerminalContext({
    page: {
      keyboard: { async press(key) { calls.push(`key:${key}`); } },
      async waitForTimeout(milliseconds) { calls.push(`wait:${milliseconds}`); },
      async screenshot(options) { calls.push(options); return Buffer.from('viewport-png'); }
    },
    answerHandle: { async evaluate() { calls.push('tail-scroll'); } }
  });

  assert.deepEqual(artifacts.map(({ kind, fileName, content }) => ({ kind, fileName, content: content.toString() })), [
    { kind: 'terminal_context_screenshot', fileName: 'terminal-context.png', content: 'viewport-png' }
  ]);
  assert.deepEqual(calls, ['key:Escape', 'tail-scroll', 'wait:500', { fullPage: false }]);
});

test('PlaywrightEvidenceProvider treats terminal context screenshot failure as supplementary', async () => {
  const provider = new PlaywrightEvidenceProvider();
  const artifacts = await provider.materializeTerminalContext({
    page: { async screenshot() { throw new Error('screenshot unavailable'); } },
    answerHandle: { async evaluate() {} }
  });
  assert.deepEqual(artifacts, []);
});

test('PlaywrightEvidenceProvider treats failure screenshots as best-effort', async () => {
  const provider = new PlaywrightEvidenceProvider();
  const artifacts = await provider.materializeFailure({
    page: { async screenshot() { throw new Error('context already closed'); } }
  });
  assert.deepEqual(artifacts, []);
});

test('PlaywrightEvidenceProvider materializes plain Yuanbao replay diagnostics as JSON', async () => {
  const provider = new PlaywrightEvidenceProvider();
  const diagnostics = {
    scope: 'accepted_response',
    trigger_count: 1,
    triggers: [{ trigger_position: 1, failure_stage: 'popup_bind', failure_reason: 'no_new_popup_after_hover' }],
    first_failure: { trigger_position: 1, expected_idx: '11', stage: 'popup_bind' },
    parsed_citations: []
  };
  const [artifact] = await provider.materializeCitationReplayDiagnostics(diagnostics);

  assert.equal(artifact.kind, 'citation_replay_diagnostics');
  assert.equal(artifact.fileName, 'citation-replay-diagnostics.json');
  assert.deepEqual(JSON.parse(artifact.content), diagnostics);
  assert.equal('handle' in artifact, false);
});
