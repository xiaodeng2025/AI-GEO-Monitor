import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const YUANBAO_SNAPSHOT_SOURCE_CONTROL_SELECTOR = '#search-guide-tool[data-toolbar-type="citation"]';
export const YUANBAO_SNAPSHOT_SOURCE_PANEL_SELECTOR = '#chatReferenceList.agent-dialogue-references';
const YUANBAO_SNAPSHOT_SIDEBAR_SELECTOR = '[aria-label="收起侧栏"]:visible';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function pageFacts(page) {
  return page.evaluate((sourceControlSelector, sourcePanelSelector) => {
    const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => Boolean(node?.getClientRects?.().length);
    const body = cleanText(document.body?.innerText);
    const panel = document.querySelector(sourcePanelSelector);
    const source = document.querySelector(sourceControlSelector);
    const heading = [...(panel?.querySelectorAll('*') || [])]
      .map((node) => cleanText(node.innerText))
      .find((text) => /^引用来源（\d+）$/.test(text)) || null;
    const sourceCount = Number(/（(\d+)）/.exec(heading || '')?.[1] || 0) || null;
    return {
      promptPresent: body.length > 0,
      sourceControlPresent: Boolean(source && visible(source)),
      sourceControlLabel: source?.getAttribute('aria-label') || null,
      sourcePanelPresent: Boolean(panel && visible(panel)),
      sourcePanelHeading: heading,
      sourcePanelCount: sourceCount,
      sourcePanelTextLength: cleanText(panel?.innerText).length,
      visibleNewChatCount: [...document.querySelectorAll('*')]
        .filter((node) => visible(node) && cleanText(node.innerText) === '新对话').length
    };
  }, YUANBAO_SNAPSHOT_SOURCE_CONTROL_SELECTOR, YUANBAO_SNAPSHOT_SOURCE_PANEL_SELECTOR);
}

/** Uses Yuanbao's native sidebar control; it never edits the page DOM. */
export async function collapseYuanbaoSidebar({ page }) {
  const control = page.locator(YUANBAO_SNAPSHOT_SIDEBAR_SELECTOR).first();
  if (!(await control.isVisible().catch(() => false))) {
    const facts = await pageFacts(page);
    return { status: facts.visibleNewChatCount === 0 ? 'already_collapsed' : 'control_not_found', facts };
  }
  const feature = await control.evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    ariaLabel: node.getAttribute('aria-label'),
    className: String(node.className || '')
  }));
  await control.click();
  await page.waitForTimeout(800);
  const facts = await pageFacts(page);
  return {
    status: facts.visibleNewChatCount === 0 ? 'collapsed' : 'collapse_not_confirmed',
    feature,
    facts
  };
}

/** Opens only Yuanbao's native source-pool panel and waits for stable content. */
export async function expandYuanbaoSources({ page, settleMs = 500, maxAttempts = 20 }) {
  const sourceControl = page.locator(YUANBAO_SNAPSHOT_SOURCE_CONTROL_SELECTOR).last();
  await sourceControl.waitFor({ state: 'visible', timeout: 5_000 });
  await sourceControl.click();
  let previous = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const facts = await pageFacts(page);
    if (facts.sourcePanelPresent && facts.sourcePanelCount && facts.sourcePanelTextLength > 0 && JSON.stringify(facts) === JSON.stringify(previous)) {
      return { status: 'expanded', facts };
    }
    previous = facts;
    await page.waitForTimeout(settleMs);
  }
  throw new Error('Yuanbao source panel did not reach a stable visible state.');
}

export async function captureYuanbaoMhtml(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
    if (!result?.data) throw new Error('CDP Page.captureSnapshot returned no MHTML data.');
    return result.data;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Captures a completed Yuanbao page after native preparation. This function
 * deliberately has no navigation, Prompt submission, acquisition, or freeze
 * logic; the returned artifact is the platform's original MHTML page state.
 */
export async function captureYuanbaoSnapshot({
  page,
  artifactDir,
  fileName = 'yuanbao-snapshot.mhtml',
  captureMhtml = captureYuanbaoMhtml
}) {
  if (!page) throw new Error('captureYuanbaoSnapshot requires a completed Yuanbao page.');
  if (!artifactDir) throw new Error('captureYuanbaoSnapshot requires artifactDir.');
  let sidebar;
  let sources;
  try {
    sidebar = await collapseYuanbaoSidebar({ page });
    if (!['collapsed', 'already_collapsed'].includes(sidebar.status)) {
      throw new Error(`Yuanbao sidebar preparation failed: ${sidebar.status}`);
    }
    sources = await expandYuanbaoSources({ page });
    const mhtml = await captureMhtml(page);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, fileName);
    await writeFile(artifactPath, mhtml, 'utf8');
    return {
      status: 'captured',
      preparation: { sidebar, sources },
      artifact: {
        kind: 'yuanbao_snapshot_mhtml',
        fileName,
        path: artifactPath,
        bytes: (await stat(artifactPath)).size
      },
      domModified: false,
      interactionFrozen: false
    };
  } catch (error) {
    return {
      status: 'capture_failed',
      error: error instanceof Error ? error.message : String(error),
      preparation: { sidebar: sidebar || null, sources: sources || null },
      artifacts: [],
      domModified: false,
      interactionFrozen: false
    };
  }
}
