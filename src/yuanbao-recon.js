import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserRuntime } from './core/browser-runtime.js';
import { yuanbaoRuntimeConfig } from './platforms/yuanbao/yuanbao-runtime-config.js';

const summaryPath = resolve('artifacts', 'yuanbao-recon', 'ui-summary.json');
const runtime = new BrowserRuntime({
  profileDir: resolve('profiles', 'yuanbao'),
  headless: false,
  ...yuanbaoRuntimeConfig
});

async function writeUiSummary(page) {
  const summary = await page.evaluate(() => {
    const attributesOf = (element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => ['role', 'aria-label', 'title', 'contenteditable', 'disabled'].includes(attribute.name) || attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, attribute.name.startsWith('data-') ? true : attribute.value]));
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      classNames: [...element.classList],
      attributes: attributesOf(element),
      visible: Boolean(element.getClientRects().length)
    });
    const ancestors = (element) => {
      const chain = [];
      let current = element.parentElement;
      while (current && chain.length < 4) {
        chain.push(describe(current));
        current = current.parentElement;
      }
      return chain;
    };
    const describeTrigger = (element) => ({ ...describe(element), ancestors: ancestors(element) });
    const popupText = (element) => String(element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    const popupSources = (popup) => [...popup.querySelectorAll('a[href]')].slice(0, 30).map((link, index) => {
      const href = link.href;
      let domain = null;
      try { domain = new URL(href).hostname; } catch {}
      return {
        position: index + 1,
        tag: link.tagName.toLowerCase(),
        href,
        domain,
        text: popupText(link),
        attributes: attributesOf(link)
      };
    });
    const popupItems = (popup) => [...popup.querySelectorAll('[role="listitem"], li')]
      .filter((element) => Boolean(element.getClientRects().length))
      .slice(0, 30)
      .map((element, index) => ({ position: index + 1, ...describe(element), text: popupText(element) }));
    const unique = (selector, limit = 30) => [...document.querySelectorAll(selector)].slice(0, limit).map(describe);
    const triggerSelector = '[aria-label*="引用"], [aria-label*="来源"], [data-source], [data-citation], [data-reference], [class*="citation" i], [class*="reference" i], [class*="cite" i]';
    const popupSelector = '[role="tooltip"], [role="dialog"], [data-popper-placement], [data-state="open"], [data-floating-ui-portal]';
    return {
      capturedAt: new Date().toISOString(),
      page: {
        path: location.pathname,
        viewport: { innerWidth, innerHeight, outerWidth, outerHeight }
      },
      composerCandidates: unique('textarea, [contenteditable="true"]'),
      actionCandidates: unique('button, [role="button"]'),
      mainRegions: unique('main, [role="main"]'),
      citationTriggerCandidates: [...document.querySelectorAll(triggerSelector)].slice(0, 30).map(describeTrigger),
      visiblePopupCandidates: [...document.querySelectorAll(popupSelector)]
        .filter((element) => Boolean(element.getClientRects().length))
        .slice(0, 10)
        .map((element) => ({
          ...describe(element),
          text: popupText(element),
          scopedSources: popupSources(element),
          scopedListItems: popupItems(element)
        }))
    };
  });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

try {
  await mkdir(resolve('artifacts', 'yuanbao-recon'), { recursive: true });
  const page = await runtime.newPage();
  await page.goto('https://yuanbao.tencent.com/', { waitUntil: 'domcontentloaded' });
  await writeUiSummary(page);
  const interval = setInterval(() => {
    writeUiSummary(page).catch((error) => console.error(`Read-only UI summary failed: ${error.message}`));
  }, 2000);
  console.log('A project-owned Yuanbao browser window is open with viewport:null. Log in manually only if needed, then inspect an existing history conversation without submitting a Prompt. A sanitized, read-only DOM summary refreshes locally every two seconds. Keep this terminal open while observing; press Ctrl+C to close the browser when finished.');
  await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
  clearInterval(interval);
} finally {
  await runtime.close();
}
