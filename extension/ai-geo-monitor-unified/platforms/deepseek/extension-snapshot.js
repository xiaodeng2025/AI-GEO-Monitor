(function installDeepSeekExtensionSnapshot(global) {
  'use strict';

  const PREPARE = 'AI_GEO_DEEPSEEK_SNAPSHOT_PREPARE';
  const FREEZE = 'AI_GEO_DEEPSEEK_SNAPSHOT_FREEZE';
  const SOURCE_LABEL = /^搜索到\s*\d+\s*个网页$/;
  const SOURCE_READY_TIMEOUT_MS = 3_000;

  function textOf(node) { return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim(); }
  function visible(node) {
    if (!node?.getClientRects?.().length) return false;
    const style = global.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function elements() { return [...document.querySelectorAll('*')]; }
  function waitFor(check, timeoutMs = 1_500) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (check()) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        global.setTimeout(poll, 50);
      };
      poll();
    });
  }
  function sourcePanel() {
    const heading = elements().find((node) => visible(node) && node.getAttribute('role') === 'heading' && textOf(node) === '搜索结果');
    let panel = null;
    for (let node = heading?.parentElement; node; node = node.parentElement) {
      if (node.querySelectorAll('a[href]').length > 0) { panel = node; break; }
    }
    return { heading, panel, sourceItemCount: panel?.querySelectorAll('a[href]').length || 0 };
  }
  function sourceExpectedCount() {
    const label = elements().filter(visible).map(textOf).find((text) => SOURCE_LABEL.test(text)) || '';
    return Number(/(\d+)/.exec(label)?.[1] || 0);
  }

  async function collapseSidebar() {
    const newChat = elements().find((node) => visible(node) && textOf(node) === '开启新对话');
    if (!newChat) return;
    const controls = [...document.querySelectorAll('div.e066abb8 + div._23e1c55 > [role="button"]')];
    if (controls.length !== 2) throw new Error('DeepSeek sidebar control was not confirmed.');
    controls[1].click();
    const collapsed = await waitFor(() => !elements().some((node) => visible(node) && (textOf(node) === '开启新对话' || textOf(node) === '今天')));
    if (!collapsed) throw new Error('DeepSeek sidebar did not collapse.');
  }
  async function expandSources() {
    const control = elements().filter(visible).filter((node) => SOURCE_LABEL.test(textOf(node))).at(-1);
    if (!control) return { expected: 0 };
    control.click();
    const ready = await waitFor(() => {
      const panel = sourcePanel();
      return Boolean(panel.heading && panel.panel && panel.sourceItemCount > 0);
    }, SOURCE_READY_TIMEOUT_MS);
    if (!ready) throw new Error('DeepSeek source content did not load before Snapshot capture.');
    return { expected: sourceExpectedCount() };
  }

  function resolvedUrl(value) {
    try { return new URL(value, document.baseURI).href; } catch (_) { return value || ''; }
  }
  function resourceLookup(resources) {
    const values = new Map();
    for (const resource of resources || []) for (const key of resource?.keys || []) values.set(key, resource);
    return (value) => values.get(resolvedUrl(value)) || values.get(value) || null;
  }
  function rewriteCssUrls(css, getResource) {
    return String(css || '').replace(/@font-face\s*\{[^}]*\}/gi, '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, quote, value) => {
      if (!value || /^data:/i.test(value) || value.startsWith('#')) return `url(${quote}${value}${quote})`;
      const resource = getResource(value);
      if (resource?.data_url) return `url("${resource.data_url}")`;
      return /^https?:/i.test(resolvedUrl(value)) ? 'url("data:,")' : `url(${quote}${value}${quote})`;
    });
  }
  function dataResource(node, attribute, getResource) {
    const value = node.getAttribute(attribute);
    const resource = value && getResource(value);
    if (resource?.data_url) node.setAttribute(attribute, resource.data_url);
    else if (value && /^https?:/i.test(resolvedUrl(value))) node.removeAttribute(attribute);
  }
  function release(nodes, windowRef) {
    const released = [];
    for (const node of nodes) {
      const computed = windowRef.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const internallyScrollable = node.scrollHeight > node.clientHeight + 2 && /^(auto|scroll)$/.test(computed.overflowY);
      const fullScreenClipped = computed.overflowY === 'hidden' && node.clientHeight >= windowRef.innerHeight - 2;
      if (!internallyScrollable && !fullScreenClipped) continue;
      for (const [property, value] of [['display', 'block'], ['height', 'auto'], ['max-height', 'none'], ['min-height', '0'], ['overflow', 'visible'], ['flex', 'none']]) node.style.setProperty(property, value, 'important');
      if ((computed.position === 'absolute' || computed.position === 'fixed') && rect.width >= windowRef.innerWidth - 2 && rect.height >= windowRef.innerHeight - 2) node.style.setProperty('position', 'static', 'important');
      released.push(node);
    }
    return released;
  }
  function freezeInOfflineFrame(snapshot, { expected, resources }) {
    const getResource = resourceLookup(resources);
    snapshot.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove());
    snapshot.querySelectorAll('*').forEach((node) => {
      [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)).forEach((attribute) => node.removeAttribute(attribute.name));
    });
    snapshot.querySelectorAll('link[rel~="stylesheet"]').forEach((node) => {
      const resource = getResource(node.getAttribute('href'));
      if (!resource?.text) return node.remove();
      const style = document.createElement('style');
      style.setAttribute('data-dead-snapshot-stylesheet', 'true');
      style.textContent = rewriteCssUrls(resource.text, getResource);
      node.replaceWith(style);
    });
    snapshot.querySelectorAll('img[src], source[src], video[poster], link[rel~="icon"][href]').forEach((node) => dataResource(node, node.hasAttribute('poster') ? 'poster' : (node.hasAttribute('src') ? 'src' : 'href'), getResource));
    snapshot.querySelectorAll('style').forEach((node) => { node.textContent = rewriteCssUrls(node.textContent, getResource); });
    snapshot.querySelectorAll('[style]').forEach((node) => { node.setAttribute('style', rewriteCssUrls(node.getAttribute('style'), getResource)); });
    snapshot.querySelectorAll('a').forEach((node) => {
      const href = node.getAttribute('href');
      if (href) node.setAttribute('data-original-href', resolvedUrl(href));
      node.removeAttribute('href'); node.removeAttribute('target'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
    });
    snapshot.querySelectorAll('input, textarea, select, button').forEach((node) => { node.setAttribute('disabled', ''); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); });
    snapshot.querySelectorAll('[role="button"], [contenteditable="true"]').forEach((node) => { node.setAttribute('data-original-role', node.getAttribute('role') || ''); node.removeAttribute('role'); node.removeAttribute('contenteditable'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1'); });
    return '<!DOCTYPE html>\n' + snapshot.outerHTML;
  }
  async function deadHtmlFromLivePage({ expected, resources }) {
    const snapshot = document.documentElement.cloneNode(true);
    const source = freezeInOfflineFrame(snapshot, { expected, resources });
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1280px;height:900px;visibility:hidden';
    const loaded = new Promise((resolve, reject) => {
      const timer = global.setTimeout(() => reject(new Error('DeepSeek offline Snapshot frame did not load.')), SOURCE_READY_TIMEOUT_MS);
      frame.addEventListener('load', () => { global.clearTimeout(timer); resolve(); }, { once: true });
    });
    frame.srcdoc = source; document.body.append(frame);
    try {
      await loaded;
      const offline = frame.contentDocument;
      const offlineWindow = frame.contentWindow;
      const answer = offline.querySelector('.ds-markdown.ds-assistant-message-main-content');
      const answerPath = [...offline.querySelectorAll('.ds-scroll-area')].flatMap((node) => node.contains(answer) || answer?.contains(node) ? [node, ...parentsUntilBody(node)] : []);
      const sourcePath = [...offline.querySelectorAll('.ds-scroll-area')].flatMap((node) => node.querySelectorAll('a[data-original-href]').length >= expected ? [node, ...parentsUntilBody(node)] : []);
      release(answerPath, offlineWindow); release(sourcePath, offlineWindow);
      offline.documentElement.style.height = 'auto'; offline.documentElement.style.overflowY = 'auto';
      if (offline.body) { offline.body.style.height = 'auto'; offline.body.style.overflowY = 'visible'; }
      const heading = [...offline.querySelectorAll('[role="heading"]')].find((node) => textOf(node) === '搜索结果');
      const candidates = [];
      for (let node = heading?.parentElement; node && node !== offline.body; node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if (rect.left >= offlineWindow.innerWidth * 0.5 && rect.width >= 250) candidates.push(node);
      }
      const rightPanel = candidates.at(-1) || candidates[0];
      if (rightPanel) rightPanel.style.setProperty('margin-left', '32px', 'important');
      const style = offline.createElement('style');
      style.textContent = 'a,[aria-disabled="true"],input:disabled,textarea:disabled,button:disabled,select:disabled{pointer-events:none!important;cursor:default!important}';
      offline.head?.append(style);
      return '<!DOCTYPE html>\n' + offline.documentElement.outerHTML;
    } finally { frame.remove(); }
  }
  function parentsUntilBody(node) {
    const parents = [];
    for (let current = node.parentElement; current && current !== current.ownerDocument.body; current = current.parentElement) parents.push(current);
    return parents;
  }
  async function prepare() { await collapseSidebar(); return { prepared: true, ...(await expandSources()) }; }
  async function freeze(message) { return { prepared: true, artifact_html: await deadHtmlFromLivePage({ expected: Number(message.expected || 0), resources: message.resources || [] }) }; }

  global.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== PREPARE && message?.type !== FREEZE) return false;
    const action = message.type === PREPARE ? prepare() : freeze(message);
    action.then(sendResponse).catch((error) => sendResponse({ error: String(error?.message || error) }));
    return true;
  });
})(globalThis);
