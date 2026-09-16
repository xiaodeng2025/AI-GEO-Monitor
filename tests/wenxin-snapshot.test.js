import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWenxinSnapshot, collapseWenxinSidebar, expandWenxinSources } from '../src/runtime/playwright/wenxin-snapshot.js';

class FakeLocator {
  constructor(page, selector, pattern = null) { this.page = page; this.selector = selector; this.pattern = pattern; }
  filter({ hasText }) { return new FakeLocator(this.page, this.selector, hasText); }
  first() { return this; }
  last() { return this; }
  async isVisible() { return this.selector.includes('button') || this.selector.includes('role'); }
  async waitFor() { this.page.calls.push(['waitFor', this.selector]); }
  async click() {
    this.page.calls.push(['click', this.selector, String(this.pattern)]);
    if (this.pattern?.test?.('收起侧栏')) this.page.collapsed = true;
    if (this.pattern?.test?.('全球搜检索资料') || this.selector.startsWith('text=')) this.page.expanded = true;
  }
}

class FakePage {
  constructor() { this.calls = []; this.collapsed = false; this.expanded = false; this.cdpCalls = []; }
  locator(selector) { return new FakeLocator(this, selector); }
  async waitForTimeout() {}
  async evaluate() {
    return {
      evidence: this.expanded,
      sourceRowCount: this.expanded ? 3 : 0,
      sourceTextLength: this.expanded ? 120 : 0,
      bodyLength: 300
    };
  }
  context() {
    return { newCDPSession: async () => ({
      send: async (method, params) => { this.cdpCalls.push([method, params]); return { data: 'WENXIN-MHTML' }; },
      detach: async () => { this.cdpCalls.push(['detach']); }
    }) };
  }
}

test('Wenxin snapshot uses native sidebar/source controls and dynamic source evidence', async () => {
  const page = new FakePage();
  const sidebar = await collapseWenxinSidebar({ page });
  const sources = await expandWenxinSources({ page, settleMs: 0, maxAttempts: 3 });
  assert.equal(sidebar.status, 'collapsed');
  assert.equal(sources.status, 'expanded');
  assert.equal(sources.facts.sourceRowCount, 3);
  assert.equal(page.calls.some(([kind, selector]) => kind === 'click' && selector.includes('已处理')), false);
  assert.equal(page.calls.some(([kind]) => kind === 'submitPrompt'), false);
});

test('Wenxin snapshot captures MHTML without DOM rewrite or interaction freeze', async () => {
  const page = new FakePage();
  const artifactDir = await mkdtemp(join(tmpdir(), 'wenxin-snapshot-test-'));
  const result = await captureWenxinSnapshot({ page, artifactDir });
  assert.equal(result.status, 'captured');
  assert.equal(result.artifact.kind, 'wenxin_snapshot_mhtml');
  assert.equal(await readFile(result.artifact.path, 'utf8'), 'WENXIN-MHTML');
  assert.deepEqual(page.cdpCalls[0], ['Page.captureSnapshot', { format: 'mhtml' }]);
  assert.equal(result.domModified, false);
  assert.equal(result.interactionFrozen, false);
});

test('Wenxin capture failure is independent and never becomes acquisition data', async () => {
  const page = new FakePage();
  const result = await captureWenxinSnapshot({
    page,
    artifactDir: await mkdtemp(join(tmpdir(), 'wenxin-snapshot-failure-test-')),
    captureMhtml: async () => { throw new Error('synthetic CDP failure'); }
  });
  assert.equal(result.status, 'capture_failed');
  assert.match(result.error, /synthetic CDP failure/);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.domModified, false);
  assert.equal(result.interactionFrozen, false);
});
