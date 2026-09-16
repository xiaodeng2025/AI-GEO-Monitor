import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureYuanbaoSnapshot,
  collapseYuanbaoSidebar,
  expandYuanbaoSources
} from '../src/runtime/playwright/yuanbao-snapshot.js';

class FakeLocator {
  constructor(page, selector) { this.page = page; this.selector = selector; }
  first() { return this; }
  last() { return this; }
  async isVisible() { return this.selector.includes('收起侧栏') ? !this.page.collapsed : true; }
  async waitFor() { this.page.calls.push(['waitFor', this.selector]); }
  async click() {
    this.page.calls.push(['click', this.selector]);
    if (this.selector.includes('收起侧栏')) this.page.collapsed = true;
    if (this.selector.includes('search-guide-tool')) this.page.panel = true;
  }
  async evaluate() { return { tag: 'div', ariaLabel: '收起侧栏', className: 'native' }; }
}

class FakePage {
  constructor() { this.calls = []; this.collapsed = false; this.panel = false; this.cdpCalls = []; }
  locator(selector) { return new FakeLocator(this, selector); }
  async waitForTimeout() {}
  async evaluate(_fn, sourceControlSelector, sourcePanelSelector) {
    this.calls.push(['evaluate', sourceControlSelector, sourcePanelSelector]);
    return {
      sourceControlPresent: true,
      sourceControlLabel: '引用68篇资料作为参考',
      sourcePanelPresent: this.panel,
      sourcePanelHeading: this.panel ? '引用来源（68）' : null,
      sourcePanelCount: this.panel ? 68 : null,
      sourcePanelTextLength: this.panel ? 100 : 0,
      visibleNewChatCount: this.collapsed ? 0 : 3
    };
  }
  async context() { return null; }
}

function fakePageWithCdp() {
  const page = new FakePage();
  page.context = () => ({
    newCDPSession: async () => ({
      send: async (method, params) => { page.cdpCalls.push([method, params]); return { data: 'MHTML-TEST' }; },
      detach: async () => { page.cdpCalls.push(['detach']); }
    })
  });
  return page;
}

test('Yuanbao snapshot uses native preparation and CDP MHTML without freeze', async () => {
  const page = fakePageWithCdp();
  const artifactDir = await mkdtemp(join(tmpdir(), 'yuanbao-snapshot-test-'));
  const result = await captureYuanbaoSnapshot({ page, artifactDir });
  assert.equal(result.status, 'captured');
  assert.equal(result.preparation.sidebar.status, 'collapsed');
  assert.equal(result.preparation.sources.status, 'expanded');
  assert.equal(result.artifact.bytes, 10);
  assert.equal(await readFile(result.artifact.path, 'utf8'), 'MHTML-TEST');
  assert.equal(result.domModified, false);
  assert.equal(result.interactionFrozen, false);
  assert.deepEqual(page.cdpCalls[0], ['Page.captureSnapshot', { format: 'mhtml' }]);
  assert.equal(page.calls.some(([kind, selector]) => kind === 'click' && selector.includes('已处理')), false);
  assert.equal(page.calls.some(([kind]) => kind === 'submitPrompt'), false);
});

test('Yuanbao snapshot preparation calls the native sidebar and source controls only', async () => {
  const page = new FakePage();
  const sidebar = await collapseYuanbaoSidebar({ page });
  assert.equal(sidebar.status, 'collapsed');
  const sources = await expandYuanbaoSources({ page, settleMs: 0, maxAttempts: 3 });
  assert.equal(sources.status, 'expanded');
  assert.deepEqual(page.calls.filter(([kind]) => kind === 'click').map(([, selector]) => selector), [
    '[aria-label="收起侧栏"]:visible',
    '#search-guide-tool[data-toolbar-type="citation"]'
  ]);
  assert.equal(page.calls.some(([kind, selector]) => kind === 'click' && selector.includes('已处理')), false);
});

test('Yuanbao snapshot capture failure is returned independently', async () => {
  const page = new FakePage();
  const result = await captureYuanbaoSnapshot({
    page,
    artifactDir: await mkdtemp(join(tmpdir(), 'yuanbao-snapshot-failure-test-')),
    captureMhtml: async () => { throw new Error('synthetic CDP failure'); }
  });
  assert.equal(result.status, 'capture_failed');
  assert.match(result.error, /synthetic CDP failure/);
  assert.equal(result.domModified, false);
  assert.equal(result.interactionFrozen, false);
});
