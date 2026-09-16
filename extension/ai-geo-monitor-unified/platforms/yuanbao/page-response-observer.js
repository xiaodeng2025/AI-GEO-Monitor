(function installYuanbaoPageResponseObserver(global) {
  'use strict';

  const RESPONSE_EVENT = '__AI_GEO_YUANBAO_POC_RESPONSE__';
  const READY_EVENT = '__AI_GEO_YUANBAO_POC_READY__';
  const INSTALL_KEY = '__AI_GEO_YUANBAO_POC_PAGE_OBSERVER__';
  const MAX_RECORDS = 40;
  const MAX_NODES = 50_000;
  const records = [];
  let visitedNodes = 0;

  if (global[INSTALL_KEY]) return;
  global[INSTALL_KEY] = true;

  function candidateUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, global.location.href);
      if (url.hostname !== 'yuanbao.tencent.com' && url.origin !== global.location.origin) return null;
      if (!/(?:^|\/)(?:conversation|search|chat|answer|completion|stream)(?:\/|$)/i.test(url.pathname)) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function publicBubble(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    if (Object.prototype.hasOwnProperty.call(value, 'icon')) {
      const icon = value.icon;
      result.icon = icon && typeof icon === 'object' ? { url: typeof icon.url === 'string' ? icon.url : null } : icon;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'text')) result.text = typeof value.text === 'string' ? value.text : value.text;
    if (Object.prototype.hasOwnProperty.call(value, 'link')) result.link = typeof value.link === 'string' ? value.link : value.link;
    return result;
  }

  function sanitizedToolCall(value) {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of ['cmpid', 'tcname', 'type', 'status', 'title', 'groupId', 'group_id']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
    }
    return result;
  }

  function bubbleLists(value, path, output = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 30 || visitedNodes >= MAX_NODES) return output;
    visitedNodes += 1;
    if (Array.isArray(value)) {
      value.forEach((item, index) => bubbleLists(item, `${path}[${index}]`, output, depth + 1));
      return output;
    }
    if (value.type === 'bubbleList' && Array.isArray(value.bubbles)) {
      output.push({
        path,
        id: typeof value.id === 'string' ? value.id : null,
        type: value.type,
        bubbles: value.bubbles.map(publicBubble).filter(Boolean)
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'bubbles') continue;
      bubbleLists(child, `${path}.${key}`, output, depth + 1);
    }
    return output;
  }

  function isQueryList(list) {
    return list.id === 'item_0' || list.bubbles.every((bubble) => !Object.prototype.hasOwnProperty.call(bubble, 'link') && !Object.prototype.hasOwnProperty.call(bubble, 'icon'));
  }

  function isResultList(list) {
    return list.id === 'item_1' || list.bubbles.some((bubble) => Object.prototype.hasOwnProperty.call(bubble, 'link') || Object.prototype.hasOwnProperty.call(bubble, 'icon'));
  }

  function searchOccurrences(payload, rootPath = 'response') {
    const output = [];
    const seen = new Set();
    let nodes = 0;
    function visit(value, path, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 30 || nodes >= MAX_NODES) return;
      nodes += 1;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        return;
      }
      const toolCall = value.tool_call || value.toolCall || (value.tcname === 'web_search' ? value : null);
      if (toolCall && (toolCall.tcname === 'web_search' || toolCall.name === 'web_search')) {
        visitedNodes = 0;
        const lists = bubbleLists(value, path);
        const queryLists = lists.filter(isQueryList);
        const resultLists = lists.filter((list) => !queryLists.includes(list) && isResultList(list));
        const resultList = resultLists.at(-1) || lists.filter((list) => !queryLists.includes(list)).at(-1) || null;
        const queryList = queryLists.find((list) => list.id === 'item_0') || queryLists[0] || null;
        if (resultList && !seen.has(path)) {
          seen.add(path);
          output.push({
            path,
            tool_call: sanitizedToolCall(toolCall),
            query_items: queryList ? [queryList] : [],
            result_items: [resultList]
          });
        }
      }
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, depth + 1);
    }
    visit(payload, rootPath);
    return output;
  }

  function parseResponseText(text) {
    const values = [];
    try { values.push(JSON.parse(text)); } catch (_) {}
    if (!values.length) {
      for (const line of String(text || '').split(/\r?\n/)) {
        const candidate = line.replace(/^data:\s*/, '').trim();
        if (!candidate || candidate === '[DONE]') continue;
        try { values.push(JSON.parse(candidate)); } catch (_) {}
      }
    }
    return values;
  }

  function dispatch(record) {
    records.push(record);
    while (records.length > MAX_RECORDS) records.shift();
    global.document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(record) }));
  }

  async function observeResponse({ kind, method, url, status, contentType, text }) {
    const normalizedUrl = candidateUrl(url);
    if (!normalizedUrl) return;
    const parsedValues = parseResponseText(text);
    const occurrences = parsedValues.flatMap((value, index) => searchOccurrences(value, `response[${index}]`));
    dispatch({
      captured_at: new Date().toISOString(),
      transport: { kind, method: method || null, url: normalizedUrl, status: typeof status === 'number' ? status : null, content_type: contentType || null, response_text_length: String(text || '').length },
      search_occurrences: occurrences,
      search_data_status: occurrences.length ? 'observed' : 'not_observed'
    });
  }

  const originalFetch = global.fetch;
  if (typeof originalFetch === 'function') {
    global.fetch = async function observedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const request = args[0];
        const init = args[1] || {};
        const requestUrl = typeof request === 'string' ? request : request?.url || global.location.href;
        const clone = response.clone();
        clone.text().then((text) => observeResponse({ kind: 'fetch', method: init.method || request?.method || 'GET', url: requestUrl, status: response.status, contentType: response.headers.get('content-type'), text })).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  const xhrOpen = global.XMLHttpRequest?.prototype?.open;
  const xhrSend = global.XMLHttpRequest?.prototype?.send;
  if (xhrOpen && xhrSend) {
    global.XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
      this.__AI_GEO_YUANBAO_POC_METHOD__ = method;
      this.__AI_GEO_YUANBAO_POC_URL__ = url;
      return xhrOpen.call(this, method, url, ...rest);
    };
    global.XMLHttpRequest.prototype.send = function observedSend(...args) {
      this.addEventListener('load', () => {
        observeResponse({ kind: 'xhr', method: this.__AI_GEO_YUANBAO_POC_METHOD__, url: this.__AI_GEO_YUANBAO_POC_URL__, status: this.status, contentType: this.getResponseHeader('content-type'), text: this.responseType && this.responseType !== 'text' ? '' : this.responseText }).catch(() => {});
      }, { once: true });
      return xhrSend.apply(this, args);
    };
  }

  global.document.addEventListener(READY_EVENT, () => {
    for (const record of records) global.document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: JSON.stringify(record) }));
  });
})(globalThis);
