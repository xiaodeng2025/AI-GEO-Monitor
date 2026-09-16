import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { YuanbaoResponseDom } from '../src/platforms/yuanbao/yuanbao-response-dom.js';
import { PlaywrightEvidenceProvider } from '../src/runtime/playwright/playwright-evidence-provider.js';

async function fixturePage(html) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  return { browser, page };
}

function popupMarkup(cards) {
  return `<div class="hyc-common-markdown__ref-list__popup" style="display:block">
    <div class="hyc-common-markdown__ref-list__content" data-length="${cards.length}">
      <div class="hyc-common-markdown__ref-list__header"><button disabled>back</button><button id="next"><span class="icon-arrow-right">next</span></button></div>
      <div id="card"></div>
    </div>
  </div>`;
}

function fixtureHtml() {
  const sourceSets = {
    one: [
      { idx: '1', url: 'https://source.example/a', title: 'Source A', site: 'Example A' },
      { idx: '7', url: 'https://source.example/shared', title: 'Source Shared', site: 'Example Shared' },
      { idx: '10', url: 'https://source.example/c', title: 'Source C', site: 'Example C' }
    ],
    two: [
      { idx: '7', url: 'https://source.example/shared', title: 'Source Shared again', site: 'Example Shared' },
      { idx: '8', url: 'https://source.example/d', title: 'Source D', site: 'Example D' },
      { idx: '10', url: 'https://source.example/c', title: 'Source C again', site: 'Example C' }
    ]
  };
  return `<a href="https://navigation.example/">navigation</a>
    <div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">最终答案</div>
      <a href="https://ordinary.example/">ordinary answer link</a>
      <div class="retrieval"><a href="https://retrieval.example/">retrieval result</a></div>
      <div class="hyc-common-markdown__ref-list__trigger" data-idx-list="1,7,10" data-set="one" style="display:block;width:16px;height:16px"></div>
      <div class="hyc-common-markdown__ref-list__trigger" data-idx-list="7,8,10" data-set="two" style="display:block;width:16px;height:16px"></div>
    </div>
    <script>
      const sourceSets = ${JSON.stringify(sourceSets)};
      function render(set, current) {
        const source = sourceSets[set][current];
        return '<div class="hyc-common-markdown__ref_card" data-idx="' + source.idx + '" data-url="' + source.url + '">' +
          '<h4 class="hyc-common-markdown__ref_card-title">' + source.title + '</h4>' +
          '<div class="hyc-common-markdown__ref_card-foot__source_txt">' + source.site + '</div></div>';
      }
      document.querySelectorAll('.hyc-common-markdown__ref-list__trigger').forEach((trigger) => {
        trigger.addEventListener('mouseover', () => {
          document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
          const set = trigger.dataset.set;
          document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(popupMarkup(sourceSets.one))}.replace('data-length="3"', 'data-length="' + sourceSets[set].length + '"'));
          const popup = document.querySelector('.hyc-common-markdown__ref-list__popup');
          let current = 0;
          popup.querySelector('#card').innerHTML = render(set, current);
          popup.querySelector('#next').onclick = () => { current += 1; popup.querySelector('#card').innerHTML = render(set, current); if (current === sourceSets[set].length - 1) popup.querySelector('#next').disabled = true; };
        });
      });
      document.querySelector('.hyc-content-md-done').addEventListener('mouseover', () => {
        document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
      });
    </script>`;
}

function replayFixtureHtml(sourceSets = {
    one: [{ idx: '2' }, { idx: '18' }],
    two: [{ idx: '5' }, { idx: '18' }, { idx: '21' }],
    three: [{ idx: '8' }, { idx: '10' }, { idx: '11' }],
    four: [{ idx: '11' }, { idx: '14' }, { idx: '25' }],
    five: [{ idx: '18' }, { idx: '22' }, { idx: '28' }]
  }) {
  const triggers = Object.keys(sourceSets).map((set) =>
    `<div class="hyc-common-markdown__ref-list__trigger" data-idx-list="${sourceSets[set].map(({ idx }) => idx).join(',')}" data-set="${set}" style="display:block;width:16px;height:16px"></div>`
  ).join('');
  return `<div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">五个引用触发器的最终答案</div>${triggers}
    </div>
    <script>
      const sourceSets = ${JSON.stringify(sourceSets)};
      function renderPopup(set, current) {
        document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
        const source = sourceSets[set][current];
        const popup = document.createElement('div');
        popup.className = 'hyc-common-markdown__ref-list__popup';
        popup.style.display = 'block';
        popup.innerHTML = '<div class="hyc-common-markdown__ref-list__content" data-length="' + sourceSets[set].length + '">' +
          '<div class="hyc-common-markdown__ref-list__header"><button disabled>back</button><button id="next"><span class="icon-arrow-right">next</span></button></div>' +
          '<div class="card-host"><div class="hyc-common-markdown__ref_card" data-idx="' + source.idx + '" data-url="https://source.example/' + source.idx + '">' +
          '<h4 class="hyc-common-markdown__ref_card-title">Source ' + source.idx + '</h4>' +
          '<div class="hyc-common-markdown__ref_card-foot__source_txt">Example ' + source.idx + '</div></div></div></div>';
        document.body.appendChild(popup);
        const next = popup.querySelector('#next');
        if (current + 1 >= sourceSets[set].length) next.disabled = true;
        next.onclick = () => renderPopup(set, current + 1);
      }
      document.querySelectorAll('.hyc-common-markdown__ref-list__trigger').forEach((trigger) => {
        trigger.addEventListener('mouseover', () => renderPopup(trigger.dataset.set, 0));
      });
      document.querySelector('.hyc-content-md-done').addEventListener('mouseover', () => {
        document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
      });
    </script>`;
}

function popupFailureFixtureHtml({ cardMarkup, onNext = '' }) {
  return `<div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">诊断 fixture</div>
      <div class="hyc-common-markdown__ref-list__trigger" data-idx-list="1,2" style="display:block;width:16px;height:16px"></div>
    </div>
    <script>
      const trigger = document.querySelector('.hyc-common-markdown__ref-list__trigger');
      trigger.addEventListener('mouseover', () => {
        document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(cardMarkup)});
        ${onNext}
      });
    </script>`;
}

function resetAwareFixtureHtml({ clearOnNeutral = true } = {}) {
  return `<div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">Stable neutral answer area</div>
      <div id="first" class="hyc-common-markdown__ref-list__trigger" data-idx-list="1" style="display:block;width:16px;height:16px"></div>
      <div id="second" class="hyc-common-markdown__ref-list__trigger" data-idx-list="2" style="display:block;width:16px;height:16px"></div>
    </div>
    <script>
      const sources = { first: '1', second: '2' };
      function openPopup(triggerId) {
        if (document.querySelector('.hyc-common-markdown__ref-list__popup')) return;
        const idx = sources[triggerId];
        document.body.insertAdjacentHTML('beforeend', '<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="1"><div class="hyc-common-markdown__ref_card" data-idx="' + idx + '" data-url="https://source.example/' + idx + '"><h4 class="hyc-common-markdown__ref_card-title">Source ' + idx + '</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Example</div></div></div></div>');
      }
      document.querySelector('#first').addEventListener('mouseover', () => openPopup('first'));
      document.querySelector('#second').addEventListener('mouseover', () => openPopup('second'));
      ${clearOnNeutral ? "document.querySelector('.hyc-content-md-done').addEventListener('mouseover', () => document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove()));" : ''}
    </script>`;
}

test('Yuanbao response extraction uses non-outputting response and final Markdown only', async (t) => {
  const { browser, page } = await fixturePage(fixtureHtml());
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  assert.ok(root);
  assert.equal(await dom.isCompleted(root), true);
  const answer = await dom.extractAnswer(root);
  assert.equal(answer.text, '最终答案');
  const materialized = await new PlaywrightEvidenceProvider().materializeAnswer({
    handle: answer.evidenceRoot, text: answer.text, fingerprint: answer.fingerprint
  });
  assert.doesNotMatch(materialized.answer.html, /ordinary answer link|retrieval/);
});

test('Yuanbao trigger-bound Citation extraction keeps trigger order and duplicate URL occurrences', async (t) => {
  const { browser, page } = await fixturePage(fixtureHtml());
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  const result = await dom.extractCitations(root);
  assert.equal(result.status, 'captured');
  assert.deepEqual(result.citations.map((citation) => ({
    position: citation.position,
    source_position: citation.source_position,
    source_index: citation.source_index,
    title: citation.title,
    link_url: citation.link_url,
    display_domain: citation.display_domain,
    association_method: citation.association_method
  })), [
    { position: 1, source_position: 1, source_index: '1', title: 'Source A', link_url: 'https://source.example/a', display_domain: null, association_method: 'trigger_bound' },
    { position: 1, source_position: 2, source_index: '7', title: 'Source Shared', link_url: 'https://source.example/shared', display_domain: null, association_method: 'trigger_bound' },
    { position: 1, source_position: 3, source_index: '10', title: 'Source C', link_url: 'https://source.example/c', display_domain: null, association_method: 'trigger_bound' },
    { position: 2, source_position: 1, source_index: '7', title: 'Source Shared again', link_url: 'https://source.example/shared', display_domain: null, association_method: 'trigger_bound' },
    { position: 2, source_position: 2, source_index: '8', title: 'Source D', link_url: 'https://source.example/d', display_domain: null, association_method: 'trigger_bound' },
    { position: 2, source_position: 3, source_index: '10', title: 'Source C again', link_url: 'https://source.example/c', display_domain: null, association_method: 'trigger_bound' }
  ]);
});

test('Yuanbao replay diagnostics expand five triggers into fourteen occurrences', async (t) => {
  const { browser, page } = await fixturePage(replayFixtureHtml());
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  const result = await dom.extractCitations(root);

  assert.equal(result.status, 'captured');
  assert.equal(result.citations.length, 14);
  assert.equal(new Set(result.citations.map((citation) => citation.source_index)).size, 11);
  assert.equal(result.citations.filter((citation) => citation.source_index === '18').length, 3);
  assert.equal(result.citations.filter((citation) => citation.source_index === '11').length, 2);
  assert.equal(result.diagnostics.trigger_count, 5);
  assert.equal(result.diagnostics.first_failure, null);
  assert.equal(result.diagnostics.parsed_citations.length, 14);
  for (const diagnostic of result.diagnostics.triggers) {
    assert.equal(diagnostic.trigger_visible, true);
    assert.equal(diagnostic.hover_started, true);
    assert.equal(diagnostic.popup_found, true);
    assert.equal(diagnostic.popup_visible, true);
    assert.equal(diagnostic.card_found, true);
    assert.equal(diagnostic.data_url_present, true);
    assert.equal(diagnostic.failure_stage, null);
    assert.equal(diagnostic.failure_reason, null);
    assert.equal(diagnostic.parsed_citations.length, diagnostic.data_idx_list.length);
    for (const step of diagnostic.carousel_steps.slice(0, -1)) {
      assert.equal(step.next_arrow_found, true);
      assert.equal(step.next_arrow_click, true);
      assert.equal(step.dom_remounted, true);
      assert.equal(step.popup_reacquired, true);
      assert.equal(step.card_reacquired, true);
      assert.notEqual(step.new_idx, null);
      assert.notEqual(step.new_idx, step.current_idx);
      assert.ok(diagnostic.data_idx_list.includes(step.new_idx));
    }
  }
  assert.doesNotThrow(() => JSON.stringify(result.diagnostics));
});

test('Yuanbao direct trigger hover leaves the first popup bound without a reset', async (t) => {
  const { browser, page } = await fixturePage(resetAwareFixtureHtml());
  t.after(() => browser.close());
  const root = await new YuanbaoResponseDom(page).locateCompletedResponse(0);
  const triggers = root.locator('.hyc-common-markdown__ref-list__trigger');
  await triggers.nth(0).hover();
  await page.waitForTimeout(100);
  await triggers.nth(1).hover();

  const popup = page.locator('.hyc-common-markdown__ref-list__popup:visible').last();
  assert.equal(await popup.count(), 1);
  assert.equal(await popup.locator('.hyc-common-markdown__ref_card[data-url]').last().getAttribute('data-idx'), '1');
});

test('Yuanbao popup reset clears the first popup before binding the second trigger', async (t) => {
  const { browser, page } = await fixturePage(resetAwareFixtureHtml());
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'captured');
  assert.deepEqual(result.citations.map(({ source_index }) => source_index), ['1', '2']);
  assert.equal(result.diagnostics.triggers[1].popup_reset_started, true);
  assert.equal(result.diagnostics.triggers[1].popup_reset_completed, true);
  assert.equal(result.diagnostics.triggers[1].popup_reset_visible_count, 0);
  assert.ok(result.diagnostics.triggers[1].popup_reset_elapsed_ms >= 0);
});

test('Yuanbao popup reset timeout is a diagnostic failure before the next trigger hover', async (t) => {
  const { browser, page } = await fixturePage(resetAwareFixtureHtml({ clearOnNeutral: false }));
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'popup_reset_timeout');
  assert.equal(result.diagnostics.first_failure.trigger_position, 2);
  assert.equal(result.diagnostics.first_failure.stage, 'popup_reset_timeout');
  assert.equal(result.diagnostics.first_failure.reason, 'visible_citation_popup_did_not_clear');
  assert.equal(result.diagnostics.triggers[1].popup_reset_completed, false);
  assert.equal(result.diagnostics.triggers[1].popup_reset_visible_count, 1);
  assert.equal(result.diagnostics.parsed_citations.length, 1);
});

test('Yuanbao reset replay covers the accepted eight-trigger twenty-one-occurrence shape', async (t) => {
  const sourceSets = {
    one: [{ idx: '4' }, { idx: '7' }],
    two: [{ idx: '2' }, { idx: '3' }, { idx: '5' }],
    three: [{ idx: '3' }, { idx: '5' }, { idx: '8' }],
    four: [{ idx: '4' }, { idx: '6' }],
    five: [{ idx: '2' }, { idx: '5' }, { idx: '6' }],
    six: [{ idx: '5' }, { idx: '6' }, { idx: '17' }],
    seven: [{ idx: '2' }, { idx: '3' }, { idx: '6' }],
    eight: [{ idx: '1' }, { idx: '13' }]
  };
  const { browser, page } = await fixturePage(replayFixtureHtml(sourceSets));
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'captured');
  assert.equal(result.citations.length, 21);
  assert.equal(new Set(result.citations.map(({ source_index }) => source_index)).size, 10);
  assert.equal(result.diagnostics.trigger_count, 8);
  assert.equal(result.diagnostics.triggers.slice(1).every(({ popup_reset_completed }) => popup_reset_completed), true);
  assert.equal(result.diagnostics.triggers.every(({ failure_stage }) => failure_stage === null), true);
});

test('Yuanbao replay diagnostics locate a popup-open failure', async (t) => {
  const { browser, page } = await fixturePage(`
    <div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">无 popup 的诊断 fixture</div>
      <div class="hyc-common-markdown__ref-list__trigger" data-idx-list="1,2" style="display:block;width:16px;height:16px"></div>
    </div>
  `);
  t.after(() => browser.close());
  const result = await new YuanbaoResponseDom(page).extractCitations(await new YuanbaoResponseDom(page).locateCompletedResponse(0));

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'popup_not_bound_to_trigger');
  assert.deepEqual(result.diagnostics.first_failure, {
    trigger_position: 1,
    expected_idx: '1',
    current_idx: null,
    stage: 'popup_bind',
    reason: 'no_new_popup_after_hover'
  });
  assert.equal(result.diagnostics.triggers[0].popup_found, false);
  assert.equal(result.diagnostics.triggers[0].failure_stage, 'popup_bind');
});

test('Yuanbao replay diagnostics locate a carousel card-length mismatch', async (t) => {
  const html = popupFailureFixtureHtml({
    cardMarkup: '<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="1"><div class="hyc-common-markdown__ref-list__header"><button disabled>back</button><button><span class="icon-arrow-right">next</span></button></div><div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://source.example/1"><h4 class="hyc-common-markdown__ref_card-title">Source 1</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Example</div></div></div></div>'
  });
  const { browser, page } = await fixturePage(html);
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'carousel_card_mismatch');
  assert.equal(result.diagnostics.first_failure.stage, 'carousel_length');
  assert.match(result.diagnostics.first_failure.reason, /^data_length_mismatch:1:2$/);
  assert.equal(result.diagnostics.triggers[0].popup_found, true);
  assert.equal(result.diagnostics.triggers[0].card_found, true);
});

test('Yuanbao replay diagnostics locate a stale-card remount failure', async (t) => {
  const html = popupFailureFixtureHtml({
    cardMarkup: '<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="2"><div class="hyc-common-markdown__ref-list__header"><button disabled>back</button><button id="next"><span class="icon-arrow-right">next</span></button></div><div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://source.example/1"><h4 class="hyc-common-markdown__ref_card-title">Source 1</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Example</div></div></div></div>',
    onNext: "document.querySelector('#next').onclick = () => {};"
  });
  const { browser, page } = await fixturePage(html);
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'carousel_card_mismatch');
  assert.equal(result.diagnostics.first_failure.stage, 'card_reacquire');
  assert.equal(result.diagnostics.first_failure.reason, 'card_data_idx_not_changed');
  assert.equal(result.diagnostics.triggers[0].carousel_steps[0].next_arrow_click, true);
  assert.equal(result.diagnostics.triggers[0].carousel_steps[0].popup_reacquired, false);
  assert.equal(result.diagnostics.triggers[0].carousel_steps[0].card_reacquired, false);
});

test('Yuanbao replay diagnostics retain prior parsed content after a later trigger failure', async (t) => {
  const { browser, page } = await fixturePage(`
    <div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">部分解析诊断 fixture</div>
      <div id="first" class="hyc-common-markdown__ref-list__trigger" data-idx-list="1" style="display:block;width:16px;height:16px"></div>
      <div id="second" class="hyc-common-markdown__ref-list__trigger" data-idx-list="2" style="display:none;width:16px;height:16px"></div>
    </div>
    <script>
      document.querySelector('#first').addEventListener('mouseover', () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="1"><div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://source.example/1"><h4 class="hyc-common-markdown__ref_card-title">Source 1</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Example</div></div></div></div>');
      });
      document.querySelector('.hyc-content-md-done').addEventListener('mouseover', () => {
        document.querySelectorAll('.hyc-common-markdown__ref-list__popup').forEach((popup) => popup.remove());
      });
    </script>
  `);
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const result = await dom.extractCitations(await dom.locateCompletedResponse(0));

  assert.equal(result.status, 'parse_failed');
  assert.equal(result.reason, 'trigger_not_visible');
  assert.equal(result.citations.length, 0);
  assert.equal(result.diagnostics.first_failure.trigger_position, 2);
  assert.equal(result.diagnostics.parsed_citations.length, 1);
  assert.equal(result.diagnostics.parsed_citations[0].source_index, '1');
  assert.equal(result.diagnostics.triggers[0].parsed_citations.length, 1);
});

test('Yuanbao Citation parser never promotes ordinary, retrieval, or navigation links', async (t) => {
  const { browser, page } = await fixturePage(fixtureHtml());
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  const result = await dom.extractCitations(root);
  assert.equal(result.citations.some((citation) => /ordinary|retrieval|navigation/.test(citation.link_url)), false);
});

test('Yuanbao Citation parser ignores a stale visible popup that shares an index', async (t) => {
  const html = `<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="2"><div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://stale.example/1"><h4 class="hyc-common-markdown__ref_card-title">Stale</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Stale</div></div></div></div>
    <div data-conv-speaker="ai" data-conv-outputting="false"><div class="hyc-content-md-done">最终答案</div><div class="hyc-common-markdown__ref-list__trigger" data-idx-list="1,5" style="display:block;width:16px;height:16px"></div></div>
    <script>
      document.querySelector('.hyc-common-markdown__ref-list__trigger').addEventListener('mouseover', () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="hyc-common-markdown__ref-list__popup" style="display:block"><div class="hyc-common-markdown__ref-list__content" data-length="2"><div class="hyc-common-markdown__ref-list__header"><button disabled>back</button><button id="next"><span class="icon-arrow-right">next</span></button></div><div id="card"><div class="hyc-common-markdown__ref_card" data-idx="1" data-url="https://source.example/1"><h4 class="hyc-common-markdown__ref_card-title">Current one</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Current</div></div></div></div></div>');
        document.querySelectorAll('#next').forEach((button) => { button.onclick = () => { document.querySelector('#card').innerHTML = '<div class="hyc-common-markdown__ref_card" data-idx="5" data-url="https://source.example/5"><h4 class="hyc-common-markdown__ref_card-title">Current five</h4><div class="hyc-common-markdown__ref_card-foot__source_txt">Current</div></div>'; button.disabled = true; }; });
      });
    </script>`;
  const { browser, page } = await fixturePage(html);
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  const result = await dom.extractCitations(root);
  assert.equal(result.status, 'captured');
  assert.equal(result.citations[0].link_url, 'https://source.example/1');
  assert.equal(result.citations[1].link_url, 'https://source.example/5');
});

test('Yuanbao source-pool observation remains independent from Formal Citation', async (t) => {
  const { browser, page } = await fixturePage(`
    <div data-conv-speaker="ai" data-conv-outputting="false">
      <div class="hyc-content-md-done">没有正文引用。</div>
      <div id="search-guide-tool" data-toolbar-type="citation" aria-label="引用17篇资料作为参考"></div>
    </div>
  `);
  t.after(() => browser.close());
  const dom = new YuanbaoResponseDom(page);
  const root = await dom.locateCompletedResponse(0);
  const citations = await dom.extractCitations(root);
  assert.equal(citations.status, 'not_displayed');
  assert.deepEqual(citations.citations, []);
  assert.equal(citations.diagnostics.trigger_count, 0);
  assert.deepEqual(await dom.observeSourcePool(root), { platform_reported_source_count: 17 });
});
