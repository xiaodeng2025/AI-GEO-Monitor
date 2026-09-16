import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureDoubaoDeadSnapshot } from '../src/runtime/playwright/doubao-dead-snapshot.js';

test('Doubao V4 snapshot preserves page evidence while only cropping chrome and freezing interaction', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><body><div class="main-with-nav-qLRcbu"><aside class="container-hzjmF1">history</aside><main><div>问题</div><article class="md-box-root">答案 <a href="https://citation.example/one"><span class="citation">[1]</span></a></article><section data-plugin-identifier="search_query_result_block">搜索 3 个关键词，参考 2 篇资料<a href="https://source.example/one">来源一</a><a href="https://source.example/two">来源二</a></section></main></div><div style="position:fixed;bottom:0;height:140px"><div contenteditable="true">composer</div><button onclick="window.changed=true">发送</button></div><script>window.scriptPresent=true</script></body></html>`);
    const result = await captureDoubaoDeadSnapshot({ page });
    assert.equal(result.status, 'captured');
    assert.deepEqual(result.facts, { hrefs: 0, originalHrefs: 3, activeControls: 0, scripts: 0, sidebarPresent: false, composerPresent: false });
    const mhtml = result.artifacts[0].content;
    assert.match(mhtml, /data-original-href=3D"https:\/\/citation\.example\/one"/);
    assert.doesNotMatch(mhtml, /window\.scriptPresent/);
  } finally { await browser.close(); }
});
