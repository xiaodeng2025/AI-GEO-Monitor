(function installWenxinContentObserver(global) {
  'use strict';

  const EVENT_NAME = '__AI_GEO_WENXIN_POC_SEARCH_OBSERVATION__';
  const SENSITIVE_KEY = /^(token|tk|cookie|authorization|auth|credential|session)$/i;
  const SEARCH_ORIGIN = 'https://chat.baidu.com';
  const SEARCH_PATHNAME = '/csaitab/searchresult';
  const state = { search_occurrences: [], last_fingerprint: null, timer: null };

  function safePublicValue(value) {
    if (Array.isArray(value)) return value.map(safePublicValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, safePublicValue(item)]));
  }

  function parsePublicJson(value) {
    if (!value) return null;
    try { return safePublicValue(JSON.parse(value)); } catch (_) { return null; }
  }

  function publicScalar(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
  }

  function revalidateSearchObservation(incoming) {
    if (!incoming || typeof incoming !== 'object') return null;
    if (incoming.endpoint?.origin !== SEARCH_ORIGIN || incoming.endpoint?.pathname !== SEARCH_PATHNAME) return null;
    const results = Array.isArray(incoming.results) ? incoming.results.map(safePublicValue) : [];
    const capturedAt = typeof incoming.captured_at === 'string' && Number.isFinite(Date.parse(incoming.captured_at))
      ? incoming.captured_at
      : new Date().toISOString();
    return {
      endpoint: { origin: SEARCH_ORIGIN, pathname: SEARCH_PATHNAME },
      request: {
        query: publicScalar(incoming.request?.query),
        pn: publicScalar(incoming.request?.pn),
        rn: publicScalar(incoming.request?.rn)
      },
      transport: incoming.transport === 'fetch' ? 'fetch' : null,
      captured_at: capturedAt,
      privacy: { status: 'sanitized', boundary: 'isolated_revalidated', request_allowlist: ['query', 'pn', 'rn'] },
      parse_status: typeof incoming.parse_status === 'string' ? incoming.parse_status : 'unknown',
      response: {
        status: publicScalar(incoming.response?.status),
        message: publicScalar(incoming.response?.message)
      },
      results,
      result_count: results.length
    };
  }

  function textOf(node) {
    return node?.textContent?.trim() || '';
  }

  function sourcePoolFor(entry) {
    const block = entry?.querySelector('.ai-entry-block.ai-thinking-steps');
    if (!block) return { status: 'not_observed', summary: null, items: [], item_count: 0 };
    const summary = textOf(block).match(/共参考\s*(\d+)\s*篇资料/)?.[0] || null;
    const items = [...block.querySelectorAll(':scope > ol > li, ol > li')].map((node, index) => {
      const metadata = parsePublicJson(node.getAttribute('data-long-press-ext-info'));
      return {
        order: index + 1,
        text: textOf(node),
        long_press_menu: node.getAttribute('data-long-press-menu'),
        long_press_ext_info: metadata,
        link: typeof metadata?.link === 'string' ? metadata.link : null,
        link_title: typeof metadata?.linkTitle === 'string' ? metadata.linkTitle : null
      };
    });
    return { status: items.length ? 'materialized' : 'observed_empty', summary, items, item_count: items.length };
  }

  function answerFor(entry) {
    const block = entry?.querySelector('.ai-entry-block.ai-markdown');
    const content = block?.querySelector('.cosd-markdown-content') || block;
    const candidates = content ? [...content.querySelectorAll('a, button, sup')].map((node) => ({ tag: node.tagName.toLowerCase(), text: textOf(node) })) : [];
    return {
      status: content ? 'observed' : 'not_observed',
      text: textOf(content),
      html: content ? content.innerHTML : '',
      component_metadata: parsePublicJson(block?.getAttribute('data-show-log')),
      citation_candidates: candidates
    };
  }

  function currentConversationUrl(locationRef = global.location) {
    const href = locationRef?.href;
    if (typeof href !== 'string') return '';
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.hostname !== 'wenxin.baidu.com') return '';
      if (!/^\/search\/[^/]+$/.test(url.pathname)) return '';
      return href;
    } catch (_) {
      return '';
    }
  }

  function snapshot() {
    const entries = global.document ? [...document.querySelectorAll('.ai-entry')] : [];
    const entry = entries.at(-1) || null;
    const answer = answerFor(entry);
    const source_pool = sourcePoolFor(entry);
    const citationStatus = answer.citation_candidates.length ? 'candidate_observed' : 'not_observed';
    return {
      research_format: 'wenxin-raw-observation-poc',
      platform: { id: 'wenxin', host: global.location?.host || null, path: global.location?.pathname || null },
      conversation_url: currentConversationUrl(),
      observation_state: entry ? 'entry_observed' : 'waiting_for_entry',
      response: { entry_count: entries.length, present: Boolean(entry) },
      final_answer: answer,
      processing: { status: 'not_observed' },
      source_pool,
      search: {
        dom_status: 'not_observed',
        occurrence_count: state.search_occurrences.length,
        occurrences: state.search_occurrences,
        latest: state.search_occurrences.at(-1) || null
      },
      formal_citation: { status: citationStatus, candidates: answer.citation_candidates },
      raw_acquisition: { status: state.search_occurrences.length ? 'observed' : 'not_observed', privacy: 'sanitized_allowlist_only' },
      captured_at: new Date().toISOString()
    };
  }

  function publish() {
    const result = snapshot();
    const fingerprintSource = { ...result };
    delete fingerprintSource.captured_at;
    const fingerprint = JSON.stringify(fingerprintSource);
    if (fingerprint === state.last_fingerprint) return false;
    state.last_fingerprint = fingerprint;
    global.__AI_GEO_WENXIN_POC_LAST_RESULT__ = result;
    const unifiedSession = global.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__?.activatePlatform('wenxin');
    unifiedSession?.publishObservation(result, fingerprint);
    return true;
  }

  function schedulePublish() {
    global.clearTimeout(state.timer);
    state.timer = global.setTimeout(publish, 200);
  }

  global.__AI_GEO_WENXIN_POC__ = Object.freeze({
    export: () => JSON.stringify(global.__AI_GEO_WENXIN_POC_LAST_RESULT__),
    publish,
    revalidateSearchObservation,
    searchOccurrenceCount: () => state.search_occurrences.length
  });
  global.addEventListener(EVENT_NAME, (event) => {
    try {
      const observation = revalidateSearchObservation(JSON.parse(event.detail));
      if (!observation) return;
      state.search_occurrences.push(observation);
      publish();
    } catch (_) { /* ignore untrusted bridge payloads */ }
  });
  if (!global.document) return;
  new MutationObserver(schedulePublish).observe(document.documentElement || document, { childList: true, subtree: true, characterData: true, attributes: true });
  schedulePublish();
})(globalThis);
