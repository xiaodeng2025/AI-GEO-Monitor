import { chromium } from 'playwright';

const STRUCTURE = ['h1', 'h2', 'h3', 'h4', 'p', 'ol', 'ul', 'li', 'table', 'pre', 'code'];
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function quotedPrintableBuffer(value) {
  const unfolded = value.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === '=' && /^[0-9a-f]{2}$/i.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16)); index += 2;
    } else bytes.push(unfolded.charCodeAt(index) & 0xff);
  }
  return Buffer.from(bytes);
}

// CDP supplies a whole-page multipart archive. All captured resource parts are
// retained; the later dead derivative only rewrites their addresses offline.
export function deepSeekMhtmlResources(mhtml) {
  const headerEnd = mhtml.search(/\r?\n\r?\n/);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(mhtml.slice(0, headerEnd))?.[1];
  if (!boundary) return new Map();
  const resources = new Map();
  for (const section of mhtml.split(`--${boundary}`).slice(1)) {
    const splitAt = section.search(/\r?\n\r?\n/); if (splitAt < 0) continue;
    const headers = section.slice(0, splitAt);
    const body = section.slice(splitAt).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const location = /^Content-Location:\s*(.+)$/im.exec(headers)?.[1]?.trim();
    if (!location) continue;
    const type = /^Content-Type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    const encoding = /^Content-Transfer-Encoding:\s*(.+)$/im.exec(headers)?.[1]?.trim().toLowerCase();
    const bytes = encoding === 'base64' ? Buffer.from(body.replace(/\s/g, ''), 'base64')
      : encoding === 'quoted-printable' ? quotedPrintableBuffer(body) : Buffer.from(body, 'utf8');
    const resource = { type, bytes, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
    for (const key of [location, location.replace(/#.*$/, ''), decodeURIComponent(location).replace(/#.*$/, '')]) resources.set(key, resource);
  }
  return resources;
}

function snapshotFactsScript() {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const answer = document.querySelector('.ds-markdown.ds-assistant-message-main-content');
    const answerMessage = answer?.closest('.ds-message'); const messages = [...document.querySelectorAll('.ds-message')];
    const question = messages.indexOf(answerMessage) > 0 ? messages[messages.indexOf(answerMessage) - 1] : null;
    const sourceLabel = [...document.querySelectorAll('*')].map((node) => clean(node.textContent)).find((text) => /^搜索到\\s*\\d+\\s*个网页$/.test(text)) || null;
    const expected = Number(/(\\d+)/.exec(sourceLabel || '')?.[1] || 0);
    const heading = [...document.querySelectorAll('[role="heading"]')].find((node) => clean(node.textContent) === '搜索结果');
    const panel = heading && [...(function* () { for (let node = heading.parentElement; node; node = node.parentElement) yield node; })()].find((node) => node.querySelectorAll('a[href],a[data-original-href]').length >= expected);
    const scrollables = (root) => root ? [root, ...root.querySelectorAll('*')].filter((node) => node.scrollHeight > node.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)).length : 0;
    return { questionText: clean(question?.textContent), answerText: clean(answer?.textContent), citationCount: answer?.querySelectorAll('.ds-markdown-cite').length || 0, sourceLabel, sourceItemCount: panel?.querySelectorAll('a[href],a[data-original-href]').length || 0, structure: Object.fromEntries(${JSON.stringify(STRUCTURE)}.map((tag) => [tag, answer?.querySelectorAll(tag).length || 0])), answerInternalScrollCount: scrollables(answer), sourceInternalScrollCount: scrollables(panel) };
  })()`;
}

async function visible(locator) { return locator.isVisible().catch(() => false); }

/** Uses DeepSeek's native sidebar control and verifies that conversation chrome disappeared. */
export async function collapseDeepSeekSidebarForSnapshot({ page }) {
  const newChat = page.getByText('开启新对话', { exact: true });
  const today = page.getByText('今天', { exact: true });
  const before = { newChatVisible: await visible(newChat), todayVisible: await visible(today) };
  if (!before.newChatVisible) return { status: 'already_collapsed', before, after: before };
  const controls = page.locator('div.e066abb8 + div._23e1c55 > [role="button"]');
  const count = await controls.count();
  if (count !== 2) return { status: 'control_not_confirmed', before, controls: count };
  const control = controls.nth(1);
  const feature = await control.evaluate((node) => ({ tag: node.tagName, role: node.getAttribute('role'), ariaLabel: node.getAttribute('aria-label'), title: node.getAttribute('title'), className: node.className, parentClass: node.parentElement?.className || '', svgCount: node.querySelectorAll('svg').length }));
  await control.click(); await page.waitForTimeout(1_000);
  const after = { newChatVisible: await visible(newChat), todayVisible: await visible(today) };
  await page.waitForTimeout(500);
  const stable = { newChatVisible: await visible(newChat), todayVisible: await visible(today) };
  return { status: !after.newChatVisible && !after.todayVisible && JSON.stringify(after) === JSON.stringify(stable) ? 'collapsed' : 'collapse_not_confirmed', selector: 'div.e066abb8 + div._23e1c55 > [role="button"] (second native header control)', feature, before, after, stable };
}

function sourcePanelProbe() {
  return `(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const label = [...document.querySelectorAll('*')].map((node) => clean(node.textContent)).find((text) => /^搜索到\\s*\\d+\\s*个网页$/.test(text)) || null;
    const expected = Number(/(\\d+)/.exec(label || '')?.[1] || 0);
    const heading = [...document.querySelectorAll('[role="heading"]')].find((node) => clean(node.textContent) === '搜索结果');
    const panel = heading && [...(function* () { for (let node = heading.parentElement; node; node = node.parentElement) yield node; })()].find((node) => node.querySelectorAll('a[href]').length >= expected);
    const sourceItemCount = panel?.querySelectorAll('a[href]').length || 0;
    return { label, expected, panelFound: Boolean(panel), sourceItemCount, headingFound: Boolean(heading), elementCount: document.querySelectorAll('*').length };
  })()`;
}

export async function expandDeepSeekSourcePanelForSnapshot({ page }) {
  const requests = []; const listener = (request) => requests.push({ url: request.url(), type: request.resourceType() });
  page.on('request', listener);
  try {
    const before = await page.evaluate(sourcePanelProbe());
    const control = page.getByText(/搜索到\s*\d+\s*个\s*网页/).last();
    if (!(await visible(control))) return { status: 'control_not_found', before, requests };
    const actualText = clean(await control.innerText());
    await control.click(); await page.waitForTimeout(1_000);
    const after = await page.evaluate(sourcePanelProbe()); await page.waitForTimeout(500);
    const stable = await page.evaluate(sourcePanelProbe());
    return { status: stable.panelFound && stable.headingFound ? 'expanded' : 'panel_not_confirmed', actualText, selector: 'getByText(/搜索到\\s*\\d+\\s*个\\s*网页/).last()', before, after, panel: stable, newDomObserved: stable.elementCount > before.elementCount, requests };
  } finally { page.off('request', listener); }
}

export async function materializeDeepSeekSourcesForSnapshot({ page }) {
  const before = await page.evaluate(sourcePanelProbe());
  if (!before.panelFound) return { status: 'panel_not_found', before };
  if (!before.expected || before.sourceItemCount >= before.expected) return { status: 'already_materialized', before, after: before, scrolled: false };
  await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const heading = [...document.querySelectorAll('[role="heading"]')].find((node) => clean(node.textContent) === '搜索结果');
    const expected = Number(/(\d+)/.exec([...document.querySelectorAll('*')].map((node) => clean(node.textContent)).find((text) => /^搜索到\s*\d+\s*个网页$/.test(text)) || '')?.[1] || 0);
    const panel = heading && [...(function* () { for (let node = heading.parentElement; node; node = node.parentElement) yield node; })()].find((node) => node.querySelectorAll('a[href]').length >= expected);
    const target = [panel, ...(panel?.querySelectorAll('*') || [])].find((node) => node && node.scrollHeight > node.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(node).overflowY));
    if (target) target.scrollTop = target.scrollHeight;
  });
  await page.waitForTimeout(900);
  const after = await page.evaluate(sourcePanelProbe());
  return { status: after.sourceItemCount >= after.expected ? 'materialized' : 'incomplete_after_scroll', before, after, scrolled: true };
}

async function deadHtmlFromLivePage({ page, resources }) {
  const html = (await page.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); const offline = await context.newPage();
  await offline.route('**/*', (route) => route.abort());
  try {
    await offline.setContent(html, { waitUntil: 'domcontentloaded' });
    return await offline.evaluate(({ entries }) => {
      const resources = new Map(entries); const originalUrl = (value) => { try { return new URL(value, document.baseURI).href; } catch { return value; } };
      const resource = (value) => resources.get(value) || resources.get(originalUrl(value)) || resources.get(String(value).replace(/#.*$/, ''));
      const dataUri = (value) => resource(value)?.dataUrl || null;
      document.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove());
      document.querySelectorAll('*').forEach((node) => [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)).forEach((attribute) => node.removeAttribute(attribute.name)));
      document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => { const asset = resource(link.href); if (asset?.type.includes('css')) { const style = document.createElement('style'); style.setAttribute('data-dead-snapshot-stylesheet', link.href); style.textContent = new TextDecoder().decode(Uint8Array.from(atob(asset.base64), (char) => char.charCodeAt(0))); link.replaceWith(style); } else link.remove(); });
      document.querySelectorAll('img[src], source[src], video[poster], link[rel~="icon"][href]').forEach((node) => { const attribute = node.hasAttribute('poster') ? 'poster' : node.hasAttribute('src') ? 'src' : 'href'; const replacement = dataUri(node.getAttribute(attribute)); if (replacement) node.setAttribute(attribute, replacement); else if (node.tagName === 'IMG') node.removeAttribute('src'); });
      const rewriteUrls = (text) => String(text || '').replace(/url\((['"]?)([^)'" ]+)\1\)/gi, (all, quote, value) => { const replacement = dataUri(value); return replacement ? `url(${quote}${replacement}${quote})` : /^https?:/i.test(originalUrl(value)) ? 'url("data:,")' : all; });
      document.querySelectorAll('style').forEach((style) => { style.textContent = rewriteUrls(style.textContent).replace(/@font-face\s*\{[^}]*\}/gi, ''); });
      document.querySelectorAll('[style]').forEach((node) => node.setAttribute('style', rewriteUrls(node.getAttribute('style'))));
      document.querySelectorAll('a').forEach((node) => { const href = node.getAttribute('href'); if (href) node.setAttribute('data-original-href', originalUrl(href)); node.removeAttribute('href'); node.removeAttribute('target'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); });
      document.querySelectorAll('input, textarea, select, button').forEach((node) => { node.setAttribute('disabled', ''); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); });
      document.querySelectorAll('[role="button"], [contenteditable="true"]').forEach((node) => { node.setAttribute('data-original-role', node.getAttribute('role') || ''); node.removeAttribute('role'); node.removeAttribute('contenteditable'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); });
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim(); const answer = document.querySelector('.ds-markdown.ds-assistant-message-main-content');
      const sourceLabel = [...document.querySelectorAll('*')].map((node) => clean(node.textContent)).find((text) => /^搜索到\s*\d+\s*个网页$/.test(text)) || ''; const expected = Number(/(\d+)/.exec(sourceLabel)?.[1] || 0);
      const heading = [...document.querySelectorAll('[role="heading"]')].find((node) => clean(node.textContent) === '搜索结果');
      const release = (nodes) => { const released = []; for (const node of nodes) { if (!node || released.includes(node)) continue; const style = getComputedStyle(node); if ((node.scrollHeight > node.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY)) || (style.overflowY === 'hidden' && node.clientHeight >= innerHeight - 2)) { for (const [property, value] of [['display', 'block'], ['height', 'auto'], ['max-height', 'none'], ['min-height', '0'], ['overflow', 'visible'], ['flex', 'none']]) node.style.setProperty(property, value, 'important'); const rect = node.getBoundingClientRect(); if (/(absolute|fixed)/.test(style.position) && rect.width >= innerWidth - 2 && rect.height >= innerHeight - 2) node.style.setProperty('position', 'static', 'important'); released.push(node); } } return released; };
      const answerPath = [...document.querySelectorAll('.ds-scroll-area')].filter((node) => node.contains(answer) || answer?.contains(node)).flatMap((node) => { const path = []; for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) path.push(parent); return path; });
      const sourcePath = [...document.querySelectorAll('.ds-scroll-area')].filter((node) => node.querySelectorAll('a[data-original-href]').length >= expected).flatMap((node) => { const path = []; for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) path.push(parent); return path; });
      const answerUnscrolled = release(answerPath).length; const sourceUnscrolled = release(sourcePath).length;
      document.documentElement.style.height = 'auto'; document.documentElement.style.overflowY = 'auto'; document.body.style.height = 'auto'; document.body.style.overflowY = 'visible';
      let horizontalLayout = null;
      if (heading) { const candidates = []; for (let node = heading.parentElement; node && node !== document.body; node = node.parentElement) { const rect = node.getBoundingClientRect(); if (rect.left >= innerWidth * 0.5 && rect.width >= 250) candidates.push(node); } const rightPanel = candidates.at(-1) || candidates[0]; if (rightPanel) { const before = getComputedStyle(rightPanel).marginLeft; rightPanel.style.setProperty('margin-left', '32px', 'important'); horizontalLayout = { before, after: getComputedStyle(rightPanel).marginLeft }; } }
      const style = document.createElement('style'); style.textContent = 'a,[aria-disabled="true"],input:disabled,textarea:disabled,button:disabled,select:disabled{pointer-events:none!important;cursor:default!important}'; document.head.append(style);
      return { html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML, facts: { scriptCount: document.scripts.length, linkCount: document.querySelectorAll('a[href]').length, interactiveCount: document.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[role="button"],[contenteditable="true"]').length, answerUnscrolled, sourceUnscrolled, horizontalLayout } };
    }, { entries: [...resources.entries()].map(([key, value]) => [key, { type: value.type, dataUrl: value.dataUrl, base64: value.bytes.toString('base64') }]) });
  } finally { await browser.close(); }
}

async function inspectDeadHtml(html, { javaScriptEnabled }) {
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 1440, height: 1100 } }); const page = await context.newPage(); const requests = [];
  page.on('request', (request) => { if (/^https?:/i.test(request.url())) requests.push({ url: request.url(), type: request.resourceType() }); });
  try { await page.setContent(html, { waitUntil: 'load', timeout: 30_000 }); const facts = await page.evaluate(snapshotFactsScript()); const dead = await page.evaluate(() => ({ scriptCount: document.scripts.length, liveLinks: document.querySelectorAll('a[href]').length, interactive: document.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[role="button"],[contenteditable="true"]').length, pageScrollable: document.documentElement.scrollHeight > innerHeight })); return { opened: true, facts, dead, requests, screenshot: await page.screenshot({ fullPage: true }) }; }
  catch (error) { return { opened: false, error: error instanceof Error ? error.message : String(error), requests }; } finally { await browser.close(); }
}

/** Captures and materializes DeepSeek V3 evidence without changing acquisition semantics. */
export async function captureDeepSeekDeadSnapshot({ page, preparation = null }) {
  try {
    const cdp = await page.context().newCDPSession(page); let rawMhtml;
    try { rawMhtml = (await cdp.send('Page.captureSnapshot', { format: 'mhtml' })).data; } finally { await cdp.detach().catch(() => {}); }
    if (!rawMhtml) throw new Error('CDP Page.captureSnapshot returned no MHTML data.');
    const live = await page.evaluate(snapshotFactsScript()); const deadBuild = await deadHtmlFromLivePage({ page, resources: deepSeekMhtmlResources(rawMhtml) });
    const normal = await inspectDeadHtml(deadBuild.html, { javaScriptEnabled: true }); const jsDisabled = await inspectDeadHtml(deadBuild.html, { javaScriptEnabled: false });
    const metadata = { status: normal.opened && jsDisabled.opened ? 'captured' : 'local_open_failed', method: 'Chrome DevTools Protocol Page.captureSnapshot({ format: "mhtml" })', conversationUrl: page.url(), snapshotVersion: 'v3', rawSnapshotFile: 'deepseek-raw-page.mhtml', snapshotFile: 'deepseek-dead-snapshot-v3.html', preparation, live, deadBuild: deadBuild.facts, normal: { ...normal, screenshot: undefined }, jsDisabled: { ...jsDisabled, screenshot: undefined }, bodyOrDomModified: false, observationRendererUsed: false, pruningOrOptimizationPerformed: false };
    return { ...metadata, artifacts: [{ kind: 'deepseek_raw_page_mhtml', fileName: metadata.rawSnapshotFile, content: rawMhtml }, { kind: 'deepseek_dead_snapshot_html', fileName: metadata.snapshotFile, content: deadBuild.html }, { kind: 'deepseek_dead_snapshot_metadata', fileName: 'deepseek-dead-snapshot-v3.json', content: `${JSON.stringify(metadata, null, 2)}\n` }, { kind: 'deepseek_snapshot_live_screenshot', fileName: 'deepseek-snapshot-live.png', content: await page.screenshot({ fullPage: false }) }, ...(normal.screenshot ? [{ kind: 'deepseek_dead_snapshot_screenshot', fileName: 'deepseek-dead-snapshot-v3.png', content: normal.screenshot }] : []), ...(jsDisabled.screenshot ? [{ kind: 'deepseek_dead_snapshot_js_disabled_screenshot', fileName: 'deepseek-dead-snapshot-v3-js-disabled.png', content: jsDisabled.screenshot }] : [])] };
  } catch (error) { return { status: 'capture_failed', error: error instanceof Error ? error.message : String(error), artifacts: [] }; }
}
