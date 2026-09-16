/**
 * Applies the already accepted Doubao V4 crop/freeze semantics to a page that
 * was opened from a saved Doubao MHTML. It neither navigates nor acquires.
 */
export async function captureDoubaoDeadSnapshot({ page }) {
  const build = await page.evaluate(() => {
    const sidebar = document.querySelector('.main-with-nav-qLRcbu > .container-hzjmF1');
    if (!sidebar) throw new Error('Doubao V4 sidebar container was not confirmed.');
    sidebar.remove();

    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) throw new Error('Doubao V4 composer editor was not confirmed.');
    let composer = null;
    for (let node = editor; node && node !== document.body; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.top > innerHeight * 0.5 && rect.bottom >= innerHeight - 1 && rect.height >= 100 && rect.height < 400) composer = node;
    }
    if (!composer) throw new Error('Doubao V4 composer container was not confirmed.');
    composer.remove();

    const absolute = (value) => { try { return new URL(value, document.baseURI).href; } catch { return value; } };
    document.querySelectorAll('a').forEach((node) => {
      const href = node.getAttribute('href');
      if (href) node.setAttribute('data-original-href', absolute(href));
      node.removeAttribute('href'); node.removeAttribute('target'); node.removeAttribute('download'); node.removeAttribute('ping');
      node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
    });
    document.querySelectorAll('button,input,textarea,select').forEach((node) => {
      node.setAttribute('disabled', ''); node.setAttribute('readonly', ''); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
    });
    document.querySelectorAll('[role="button"], [contenteditable="true"]').forEach((node) => {
      node.removeAttribute('role'); node.removeAttribute('contenteditable'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
    });
    document.querySelectorAll('*').forEach((node) => [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)).forEach((attribute) => node.removeAttribute(attribute.name)));
    document.querySelectorAll('script').forEach((node) => node.remove());
    return { sidebarRemoved: true, composerRemoved: true };
  });
  const facts = await page.evaluate(() => ({
    hrefs: document.querySelectorAll('a[href]').length,
    originalHrefs: document.querySelectorAll('a[data-original-href]').length,
    activeControls: document.querySelectorAll('button:not([disabled]),input:not([disabled]):not([readonly]),textarea:not([disabled]):not([readonly]),select:not([disabled]),[role="button"],[contenteditable="true"]').length,
    scripts: document.scripts.length,
    sidebarPresent: Boolean(document.querySelector('.main-with-nav-qLRcbu > .container-hzjmF1')),
    composerPresent: Boolean(document.querySelector('[contenteditable="true"]'))
  }));
  const cdp = await page.context().newCDPSession(page); let mhtml;
  try { mhtml = (await cdp.send('Page.captureSnapshot', { format: 'mhtml' })).data; } finally { await cdp.detach().catch(() => {}); }
  if (!mhtml) throw new Error('CDP Page.captureSnapshot returned no MHTML data.');
  return { status: 'captured', snapshotVersion: 'v4', method: 'Chrome DevTools Protocol Page.captureSnapshot({ format: "mhtml" })', build, facts, artifacts: [{ kind: 'doubao_cropped_snapshot_v4_mhtml', fileName: 'doubao-cropped-snapshot-v4.mhtml', content: mhtml }] };
}
