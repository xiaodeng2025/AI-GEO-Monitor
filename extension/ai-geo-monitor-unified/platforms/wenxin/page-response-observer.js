(function installWenxinPageResponseObserver(global) {
  'use strict';

  const EVENT_NAME = '__AI_GEO_WENXIN_POC_SEARCH_OBSERVATION__';
  const SEARCH_ORIGIN = 'https://chat.baidu.com';
  const SEARCH_PATHNAME = '/csaitab/searchresult';
  const SENSITIVE_KEY = /^(token|tk|cookie|authorization|auth|credential|session)$/i;

  function isExactSearchUrl(value) {
    try {
      const url = new URL(typeof value === 'string' ? value : value?.url, global.location?.href);
      return url.origin === SEARCH_ORIGIN && url.pathname === SEARCH_PATHNAME;
    } catch (_) {
      return false;
    }
  }

  function sanitizeSearchRequest(value) {
    const url = new URL(typeof value === 'string' ? value : value?.url, global.location?.href);
    return {
      endpoint: { origin: url.origin, pathname: url.pathname },
      request: {
        query: url.searchParams.get('query'),
        pn: url.searchParams.get('pn'),
        rn: url.searchParams.get('rn')
      }
    };
  }

  function sanitizePublicValue(value) {
    if (Array.isArray(value)) return value.map(sanitizePublicValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, sanitizePublicValue(item)]));
  }

  function parseSearchResponse(payload) {
    if (!payload || typeof payload !== 'object') {
      return { parse_status: 'malformed_json', response: null, results: [], result_count: 0 };
    }
    const results = Array.isArray(payload.data?.results) ? payload.data.results.map(sanitizePublicValue) : [];
    return {
      parse_status: Array.isArray(payload.data?.results) ? 'observed' : 'results_not_present',
      response: sanitizePublicValue({ status: payload.status, message: payload.message }),
      results,
      result_count: results.length
    };
  }

  function dispatch(observation) {
    global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: JSON.stringify(observation) }));
  }

  function createObservation(input, responseStatus, payload, parseFailure) {
    const request = sanitizeSearchRequest(input);
    const parsed = parseFailure
      ? { parse_status: 'malformed_json', response: { status: responseStatus ?? null, message: null }, results: [], result_count: 0 }
      : parseSearchResponse(payload);
    return {
      ...request,
      transport: 'fetch',
      captured_at: new Date().toISOString(),
      privacy: { request_allowlist: ['query', 'pn', 'rn'], status: 'sanitized' },
      ...parsed
    };
  }

  global.__AI_GEO_WENXIN_POC_PAGE_API__ = Object.freeze({
    EVENT_NAME,
    isExactSearchUrl,
    sanitizeSearchRequest,
    sanitizePublicValue,
    parseSearchResponse,
    createObservation
  });

  if (typeof global.fetch !== 'function') return;
  const originalFetch = global.fetch;
  global.fetch = async function observedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    if (!isExactSearchUrl(args[0])) return response;
    try {
      const payload = await response.clone().json();
      dispatch(createObservation(args[0], response.status, payload, false));
    } catch (_) {
      try { dispatch(createObservation(args[0], response.status, null, true)); } catch (_) { /* preserve page behavior */ }
    }
    return response;
  };
})(globalThis);
