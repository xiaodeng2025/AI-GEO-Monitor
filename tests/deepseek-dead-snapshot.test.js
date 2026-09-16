import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureDeepSeekDeadSnapshot } from '../src/runtime/playwright/deepseek-dead-snapshot.js';

test('DeepSeek dead snapshot keeps evidence text while removing executable and external behavior', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 300 } });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><head>
      <style>.ds-scroll-area{height:90px;overflow-y:auto}.asset{background:url(https://assets.example/pixel.png)}</style>
      <script>window.shouldNotSurvive = true</script></head><body>
      <div class="ds-message">今年中国新能源汽车出口主要增长市场有哪些？</div>
      <div class="ds-message"><div class="ds-scroll-area"><article class="ds-markdown ds-assistant-message-main-content"><h2>主要市场</h2><p>欧洲、东南亚和拉丁美洲增长较快。</p><p>${'完整答案内容。'.repeat(80)}</p><a href="https://source.example/citation"><span class="ds-markdown-cite">[1]</span></a></article></div></div>
      <div>搜索到 2 个网页</div><aside><div class="ds-scroll-area"><div role="heading">搜索结果</div><a href="https://source.example/one">来源一</a><a href="https://source.example/two">来源二</a></div></aside>
      <textarea>不可编辑</textarea><button type="button">不可点击</button><div role="button">原生控件</div>
      </body></html>`);
    const result = await captureDeepSeekDeadSnapshot({ page, preparation: { sidebar: { status: 'collapsed' }, sourcePanel: { status: 'expanded' } } });
    assert.equal(result.status, 'captured');
    assert.equal(result.live.questionText, '今年中国新能源汽车出口主要增长市场有哪些？');
    assert.match(result.live.answerText, /欧洲、东南亚和拉丁美洲增长较快/);
    assert.equal(result.normal.dead.scriptCount, 0);
    assert.equal(result.normal.dead.liveLinks, 0);
    assert.equal(result.normal.dead.interactive, 0);
    assert.equal(result.normal.requests.length, 0);
    assert.equal(result.normal.facts.answerText, result.live.answerText);
    assert.equal(result.normal.facts.sourceItemCount, 2);
    assert.equal(result.normal.facts.answerInternalScrollCount, 0);
    assert.equal(result.normal.facts.sourceInternalScrollCount, 0);
    assert.equal(result.jsDisabled.opened, true);
    const html = result.artifacts.find(({ kind }) => kind === 'deepseek_dead_snapshot_html').content;
    assert.match(html, /data-original-href="https:\/\/source\.example\/citation"/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /https:\/\/assets\.example\/pixel\.png/);
  } finally { await browser.close(); }
});
