(function installWenxinExtensionSnapshot(global) {
  'use strict';

  const PREPARE = 'AI_GEO_WENXIN_SNAPSHOT_PREPARE';
  const SOURCE_TRIGGER = /全球搜|搜索全球|引用网站|引用来源|来源网站|检索\s*\d+\s*篇资料|共参考\s*\d+\s*篇资料/;
  const SETTLE_MS = 500;
  const MAX_ATTEMPTS = 20;
  const ANSWER_STABLE_MS = 2_000;
  const ANSWER_TIMEOUT_MS = 180_000;

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function visible(node) {
    if (!node?.getClientRects?.().length) return false;
    const style = global.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function currentEntry() { return [...document.querySelectorAll('.ai-entry')].filter(visible).at(-1) || null; }
  function answerText(entry = currentEntry()) {
    const block = entry?.querySelector('.ai-entry-block.ai-markdown');
    return clean((block?.querySelector('.cosd-markdown-content') || block)?.innerText);
  }
  function generating() { return /停止生成|停止回答|生成中|回答中/i.test(clean(document.body?.innerText)); }
  function wait(milliseconds) { return new Promise((resolve) => global.setTimeout(resolve, milliseconds)); }

  async function waitForCompletedAnswer() {
    let previous = null;
    let stableAt = null;
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const text = answerText();
      if (text && text !== previous) stableAt = Date.now();
      previous = text;
      if (text && stableAt && !generating() && Date.now() - stableAt >= ANSWER_STABLE_MS) return { textLength: text.length };
      await wait(100);
    }
    throw new Error('Wenxin Answer did not reach a stable completed state before Snapshot capture.');
  }

  async function collapseSidebar() {
    const icon = [...document.querySelectorAll('i.cos-icon.cos-icon-sidebar-right')].find(visible);
    const control = icon?.closest('button, [role="button"]') || icon;
    if (!control) return { status: 'not_found' };
    control.click();
    await wait(500);
    return { status: 'collapsed' };
  }

  function sourceFacts(entry = currentEntry()) {
    const rows = [...(entry?.querySelectorAll('.ai-entry-block.ai-thinking-steps ol > li[data-long-press-ext-info]') || [])]
      .filter(visible)
      .map((node) => {
        let metadata = null;
        try { metadata = JSON.parse(node.getAttribute('data-long-press-ext-info')); } catch (_) {}
        return { text: clean(node.innerText), link: typeof metadata?.link === 'string' ? metadata.link : null, linkTitle: typeof metadata?.linkTitle === 'string' ? metadata.linkTitle : null };
      })
      .filter((row) => row.text && (row.link || row.linkTitle));
    return { entryPresent: Boolean(entry), rows };
  }

  async function expandSources() {
    const trigger = [...document.querySelectorAll('*')].filter((node) => visible(node) && SOURCE_TRIGGER.test(clean(node.innerText))).at(-1);
    if (!trigger) throw new Error('Wenxin native source trigger was not found.');
    trigger.click();
    let previous = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = sourceFacts();
      if (current.rows.length > 0 && JSON.stringify(current) === JSON.stringify(previous)) return { status: 'expanded', facts: current };
      previous = current;
      await wait(SETTLE_MS);
    }
    throw new Error('Wenxin source website rows did not become stable after the native trigger click.');
  }

  async function prepare() {
    const answer = await waitForCompletedAnswer();
    const sidebar = await collapseSidebar();
    const sources = await expandSources();
    return { prepared: true, answer, sidebar, sources };
  }

  global.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== PREPARE) return false;
    prepare().then(sendResponse).catch((error) => sendResponse({ error: String(error?.message || error) }));
    return true;
  });
})(globalThis);
