(function installDoubaoResponseProbe(global) {
  'use strict';

  const NAMESPACE = 'AI_GEO_DOUBAO_RESPONSE_PROBE';
  const REQUEST_SNAPSHOT = 'REQUEST_SNAPSHOT';
  const RESPONSE_SNAPSHOT = 'RESPONSE_SNAPSHOT';
  const CANDIDATE_PATHS = new Set([
    '/alice/search/launch',
    '/im/conversation/batch_get',
    '/im/message/send_rate_limit',
    '/im/conversation/info'
  ]);
  const SENSITIVE_KEY_RE = /(?:cookie|token|auth|authorization|signature|sig|secret|password|passwd|credential|session(?:id)?|access[-_]?key|api[-_]?key)/i;
  if (global.__AI_GEO_DOUBAO_RESPONSE_PROBE_INSTALLED__) return;

  const state = {
    installed: true,
    probe_started_at: new Date().toISOString(),
    occurrence: 0,
    facts: []
  };
  global.__AI_GEO_DOUBAO_RESPONSE_PROBE_INSTALLED__ = true;

  function isSensitiveKey(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_KEY_RE.test(String(key || '')) || normalized === 'abogus';
  }

  function sanitizeUrlString(value, path, redactions) {
    const raw = String(value);
    if (!/^(?:https?:\/\/|\/\/)/i.test(raw)) return raw;
    try {
      const protocolRelative = raw.startsWith('//');
      const parsed = new URL(raw, protocolRelative ? `https:${raw}` : undefined);
      const query = [];
      for (const [key, queryValue] of parsed.searchParams.entries()) {
        const redacted = isSensitiveKey(key);
        query.push({ key, value: redacted ? null : queryValue });
        if (redacted) redactions.push(`${path}?${key}`);
      }
      const prefix = protocolRelative ? `//${parsed.host}` : `${parsed.protocol}//${parsed.host}`;
      const sanitized = `${prefix}${parsed.pathname}`;
      const search = query.length
        ? `?${query.map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(item.value ?? '[REDACTED]')}`).join('&')}`
        : '';
      return `${sanitized}${search}`;
    } catch {
      return raw;
    }
  }

  function sanitizeTextUrls(value, path, redactions) {
    const raw = String(value);
    if (/^(?:https?:\/\/|\/\/)[^\s"'<>]+$/i.test(raw)) return sanitizeUrlString(raw, path, redactions);
    return raw.replace(/(?:https?:\/\/|\/\/)[^\s"'<>]+/gi, (candidate, offset) =>
      sanitizeUrlString(candidate.replace(/[),.;!?]+$/g, ''), `${path}?url[${offset}]`, redactions) +
      candidate.slice(candidate.replace(/[),.;!?]+$/g, '').length)
    );
  }

  function safeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl), global.location.href);
      const query = [];
      for (const [key, value] of parsed.searchParams.entries()) {
        query.push({ key, value: isSensitiveKey(key) ? null : value });
      }
      const sanitized = new URL(parsed.origin + parsed.pathname);
      for (const parameter of query) sanitized.searchParams.append(parameter.key, parameter.value ?? '[REDACTED]');
      return { url: sanitized.toString(), origin: parsed.origin, path: parsed.pathname, query };
    } catch {
      return { url: null, origin: null, path: null, query: [] };
    }
  }

  function isCandidate(rawUrl) {
    const descriptor = safeUrl(rawUrl);
    return CANDIDATE_PATHS.has(descriptor.path) ? descriptor : null;
  }

  function cloneAndRedact(value, path, redactions) {
    if (Array.isArray(value)) return value.map((item, index) => cloneAndRedact(item, `${path}[${index}]`, redactions));
    if (typeof value === 'string') return sanitizeTextUrls(value, path, redactions);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
        redactions.push(childPath);
      } else {
        result[key] = cloneAndRedact(child, childPath, redactions);
      }
    }
    return result;
  }

  function contentType(headers) {
    try { return headers?.get('content-type') || null; } catch { return null; }
  }

  function baseFact(transport, method, url, metadata = {}) {
    const descriptor = isCandidate(url);
    state.occurrence += 1;
    return {
      occurrence: state.occurrence,
      captured_at: new Date().toISOString(),
      transport,
      method: method || null,
      sanitized_url: descriptor?.url || null,
      origin: descriptor?.origin || null,
      path: descriptor?.path || null,
      query: descriptor?.query || [],
      status: metadata.status ?? null,
      status_text: metadata.status_text ?? null,
      content_type: metadata.content_type ?? null,
      response_type: metadata.response_type ?? null,
      body_status: 'unavailable',
      body_kind: 'unavailable',
      body_length: null,
      serialized_length: null,
      parsed_json: null,
      raw_text: null,
      parse_error: null,
      capture_error: null,
      redactions: []
    };
  }

  function publish() {
    global.postMessage({
      namespace: NAMESPACE,
      type: RESPONSE_SNAPSHOT,
      payload: {
        status: 'active',
        probe_started_at: state.probe_started_at,
        snapshot_at: new Date().toISOString(),
        candidate_occurrence_count: state.facts.length,
        facts: state.facts.map((fact) => ({ ...fact }))
      }
    }, '*');
  }

  function finishText(fact, text, contentKind) {
    fact.body_length = text.length;
    if (!text.length) {
      fact.body_kind = 'empty';
      fact.body_status = 'captured';
      fact.serialized_length = 0;
      publish();
      return;
    }
    try {
      const parsed = JSON.parse(text);
      fact.parsed_json = cloneAndRedact(parsed, '$', fact.redactions);
      fact.serialized_length = JSON.stringify(fact.parsed_json).length;
      fact.body_kind = 'json';
    } catch (error) {
      fact.body_kind = contentKind;
      fact.raw_text = sanitizeTextUrls(text, '$.raw_text', fact.redactions);
      fact.serialized_length = text.length;
      fact.parse_error = contentKind === 'text' ? null : error?.message || String(error);
    }
    fact.body_status = 'captured';
    publish();
  }

  async function captureFetch(fact, response) {
    try {
      const clone = response.clone();
      const text = await clone.text();
      finishText(fact, text, /json/i.test(fact.content_type || '') ? 'json' : 'text');
    } catch (error) {
      fact.body_status = 'unavailable';
      fact.capture_error = error?.message || String(error);
      publish();
    }
  }

  function captureXhr(fact, xhr) {
    try {
      const responseType = xhr.responseType || '';
      fact.status = Number.isFinite(xhr.status) ? xhr.status : null;
      fact.status_text = xhr.statusText || null;
      fact.content_type = xhr.getResponseHeader('content-type') || null;
      fact.response_type = responseType;
      if (responseType === '' || responseType === 'text') {
        finishText(fact, xhr.responseText, /json/i.test(fact.content_type || '') ? 'json' : 'text');
      } else if (responseType === 'json') {
        fact.parsed_json = cloneAndRedact(xhr.response, '$', fact.redactions);
        fact.serialized_length = JSON.stringify(fact.parsed_json).length;
        fact.body_kind = 'json';
        fact.body_status = 'captured';
        publish();
      } else {
        fact.body_status = 'unsupported';
        fact.body_kind = 'unsupported';
        publish();
      }
    } catch (error) {
      fact.body_status = 'unavailable';
      fact.capture_error = error?.message || String(error);
      publish();
    }
  }

  const originalFetch = typeof global.fetch === 'function' ? global.fetch : null;
  if (originalFetch) {
    global.fetch = function doubaoObservedFetch(...args) {
      const input = args[0];
      const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
      const descriptor = isCandidate(rawUrl);
      if (!descriptor) return originalFetch.apply(this, args);
      const method = args[1]?.method || input?.method || 'GET';
      const result = originalFetch.apply(this, args);
      Promise.resolve(result).then((response) => {
        const fact = baseFact('fetch', method, rawUrl, {
          status: response?.status,
          status_text: response?.statusText || null,
          content_type: contentType(response?.headers),
          response_type: 'default'
        });
        state.facts.push(fact);
        void captureFetch(fact, response);
      }).catch((error) => {
        const fact = baseFact('fetch', method, rawUrl, { response_type: 'default' });
        fact.capture_error = error?.message || String(error);
        state.facts.push(fact);
        publish();
      });
      return result;
    };
  }

  const originalOpen = global.XMLHttpRequest?.prototype?.open;
  const originalSend = global.XMLHttpRequest?.prototype?.send;
  if (originalOpen && originalSend) {
    const xhrMeta = new WeakMap();
    global.XMLHttpRequest.prototype.open = function doubaoObservedOpen(method, url, ...rest) {
      xhrMeta.set(this, { method: method || 'GET', url: String(url || '') });
      return originalOpen.call(this, method, url, ...rest);
    };
    global.XMLHttpRequest.prototype.send = function doubaoObservedSend(...args) {
      const meta = xhrMeta.get(this);
      const descriptor = isCandidate(meta?.url);
      if (!descriptor) return originalSend.apply(this, args);
      const fact = baseFact('xhr', meta.method, meta.url);
      state.facts.push(fact);
      this.addEventListener('loadend', () => captureXhr(fact, this), { once: true });
      return originalSend.apply(this, args);
    };
  }

  global.addEventListener('message', (event) => {
    if (event.source !== global || event.data?.namespace !== NAMESPACE || event.data?.type !== REQUEST_SNAPSHOT) return;
    publish();
  });
})(globalThis);
