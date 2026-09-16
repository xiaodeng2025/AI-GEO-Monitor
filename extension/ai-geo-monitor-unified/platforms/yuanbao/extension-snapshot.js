(function installYuanbaoExtensionSnapshot(global) {
  'use strict';

  const PREPARE = 'AI_GEO_YUANBAO_SNAPSHOT_PREPARE';
  const SOURCE_CONTROL_SELECTOR = '#search-guide-tool[data-toolbar-type="citation"]';
  const SOURCE_PANEL_SELECTOR = '#chatReferenceList.agent-dialogue-references';
  const SIDEBAR_SELECTOR = '[aria-label="收起侧栏"]';
  const SETTLE_MS = 500;
  const MAX_ATTEMPTS = 20;

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function visible(node) {
    if (!node?.getClientRects?.().length) return false;
    const style = global.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function facts() {
    const panel = document.querySelector(SOURCE_PANEL_SELECTOR);
    const heading = [...(panel?.querySelectorAll('*') || [])]
      .map((node) => clean(node.innerText))
      .find((text) => /^引用来源（\d+）$/.test(text)) || null;
    const count = Number(/（(\d+)）/.exec(heading || '')?.[1] || 0) || null;
    return {
      sourcePanelPresent: Boolean(panel && visible(panel)),
      sourcePanelHeading: heading,
      sourcePanelCount: count,
      sourcePanelTextLength: clean(panel?.innerText).length,
      visibleNewChatCount: [...document.querySelectorAll('*')].filter((node) => visible(node) && clean(node.innerText) === '新对话').length
    };
  }
  function wait(milliseconds) { return new Promise((resolve) => global.setTimeout(resolve, milliseconds)); }

  async function collapseSidebar() {
    const control = [...document.querySelectorAll(SIDEBAR_SELECTOR)].find(visible);
    if (!control) {
      const current = facts();
      if (current.visibleNewChatCount === 0) return { status: 'already_collapsed', facts: current };
      throw new Error('Yuanbao sidebar control was not confirmed.');
    }
    control.click();
    await wait(800);
    const current = facts();
    if (current.visibleNewChatCount !== 0) throw new Error('Yuanbao sidebar did not collapse.');
    return { status: 'collapsed', facts: current };
  }

  async function expandSources() {
    const control = [...document.querySelectorAll(SOURCE_CONTROL_SELECTOR)].filter(visible).at(-1);
    if (!control) throw new Error('Yuanbao native source control was not found.');
    control.click();
    let previous = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = facts();
      if (current.sourcePanelPresent && current.sourcePanelCount && current.sourcePanelTextLength > 0 && JSON.stringify(current) === JSON.stringify(previous)) {
        return { status: 'expanded', facts: current };
      }
      previous = current;
      await wait(SETTLE_MS);
    }
    throw new Error('Yuanbao source panel did not reach a stable visible state.');
  }

  async function prepare() {
    const sidebar = await collapseSidebar();
    const sources = await expandSources();
    return { prepared: true, sidebar, sources };
  }

  global.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== PREPARE) return false;
    prepare().then(sendResponse).catch((error) => sendResponse({ error: String(error?.message || error) }));
    return true;
  });
})(globalThis);
