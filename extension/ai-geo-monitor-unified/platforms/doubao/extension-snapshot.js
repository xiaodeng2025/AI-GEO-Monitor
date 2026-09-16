(function installDoubaoExtensionSnapshot(global) {
  'use strict';

  const PREPARE = 'AI_GEO_DOUBAO_SNAPSHOT_PREPARE';
  const RESTORE = 'AI_GEO_DOUBAO_SNAPSHOT_RESTORE';
  const REFERENCE_SUMMARY = /^搜索\s*\d+\s*个关键词\s*[,，]?\s*参考\s*\d+\s*篇资料$/;
  const preparedSnapshots = new Map();

  function textOf(node) { return String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim(); }

  function visible(node) { return Boolean(node?.getClientRects?.().length); }

  function ancestors(node) {
    const result = [];
    for (let current = node?.parentElement, depth = 0; current && current !== document.body && depth < 5; current = current.parentElement, depth += 1) result.push(current);
    return result;
  }

  function referenceEntry() {
    const matches = [...document.querySelectorAll('body *')]
      .filter(visible)
      .filter((node) => REFERENCE_SUMMARY.test(textOf(node)));
    matches.sort((left, right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length);
    const summary = matches[0] || null;
    if (!summary) return null;
    const control = [summary, ...ancestors(summary)]
      .find((node) => node.hasAttribute('aria-expanded') || /^(BUTTON|SUMMARY)$/.test(node.tagName) || node.getAttribute('role') === 'button') || summary;
    return { summary, control };
  }

  function sourceContentVisible(entry) {
    const sourceRoots = [entry.summary, ...ancestors(entry.summary)]
      .filter((node) => String(node.getAttribute('data-plugin-identifier') || '').includes('search_query_result_block'));
    if (sourceRoots.length) {
      return sourceRoots.some((root) => [...root.querySelectorAll('*')]
        .some((node) => visible(node) && node !== entry.summary && !entry.summary.contains(node) && textOf(node)));
    }
    const scopes = [entry.control, entry.summary, ...ancestors(entry.control)];
    return scopes.some((scope) => [...scope.querySelectorAll('a[href], li, [role="listitem"]')]
      .some((node) => visible(node) && textOf(node) && textOf(node) !== textOf(entry.summary)));
  }

  function expanded(entry) {
    return sourceContentVisible(entry);
  }

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

  async function expandReferences() {
    const entry = referenceEntry();
    if (!entry) return null;
    entry.control.click();
    if (!await waitFor(() => expanded(entry))) throw new Error('Doubao reference websites did not expand.');
    return entry;
  }

  function moveOut(node, moved) {
    const marker = document.createComment('ai-geo-snapshot-marker');
    node.before(marker);
    moved.push({ node, marker });
    node.remove();
  }

  function restoreMoved(moved) {
    for (const { node, marker } of moved.reverse()) {
      marker.before(node);
      marker.remove();
    }
  }

  function rememberAttributes(node, attributes) {
    const record = {};
    for (const name of attributes) record[name] = node.hasAttribute(name) ? node.getAttribute(name) : null;
    return record;
  }

  function restoreAttributes(node, record) {
    for (const [name, value] of Object.entries(record)) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  }

  async function prepare(snapshotId) {
    const references = await expandReferences();
    const referenceControl = references?.control || null;
    const sidebar = document.querySelector('.main-with-nav-qLRcbu > .container-hzjmF1');
    const editor = document.querySelector('[contenteditable="true"]');
    if (!sidebar || !editor) throw new Error('Doubao V4 sidebar or composer was not confirmed.');
    let composer = null;
    for (let node = editor; node && node !== document.body; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.top > innerHeight * 0.5 && rect.bottom >= innerHeight - 1 && rect.height >= 100 && rect.height < 400) composer = node;
    }
    if (!composer) throw new Error('Doubao V4 composer container was not confirmed.');

    const moved = [];
    const attributes = [];
    moveOut(sidebar, moved);
    moveOut(composer, moved);
    document.querySelectorAll('script').forEach((node) => moveOut(node, moved));
    const absolute = (value) => { try { return new URL(value, document.baseURI).href; } catch (_) { return value; } };
    document.querySelectorAll('a').forEach((node) => {
      if (node === referenceControl) return;
      const record = rememberAttributes(node, ['href', 'target', 'download', 'ping', 'data-original-href', 'aria-disabled', 'tabindex']);
      const href = node.getAttribute('href');
      if (href) node.setAttribute('data-original-href', absolute(href));
      node.removeAttribute('href'); node.removeAttribute('target'); node.removeAttribute('download'); node.removeAttribute('ping');
      node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
      attributes.push({ node, record });
    });
    document.querySelectorAll('button,input,textarea,select').forEach((node) => {
      if (node === referenceControl) return;
      const record = rememberAttributes(node, ['disabled', 'readonly', 'aria-disabled', 'tabindex']);
      node.setAttribute('disabled', ''); node.setAttribute('readonly', ''); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
      attributes.push({ node, record });
    });
    document.querySelectorAll('[role="button"], [contenteditable="true"]').forEach((node) => {
      if (node === referenceControl) return;
      const record = rememberAttributes(node, ['role', 'contenteditable', 'aria-disabled', 'tabindex']);
      node.removeAttribute('role'); node.removeAttribute('contenteditable'); node.setAttribute('aria-disabled', 'true'); node.setAttribute('tabindex', '-1');
      attributes.push({ node, record });
    });
    preparedSnapshots.set(snapshotId, { moved, attributes });
    return { prepared: true };
  }

  async function restore(snapshotId) {
    const state = preparedSnapshots.get(snapshotId);
    if (!state) return { restored: false };
    for (const { node, record } of state.attributes.reverse()) restoreAttributes(node, record);
    restoreMoved(state.moved);
    preparedSnapshots.delete(snapshotId);
    return { restored: true };
  }

  global.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== PREPARE && message?.type !== RESTORE) return false;
    const action = message.type === PREPARE ? prepare : restore;
    action(message.snapshot_id).then(sendResponse).catch((error) => sendResponse({ error: String(error?.message || error) }));
    return true;
  });
})(globalThis);
