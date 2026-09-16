(function installYuanbaoRawObservationPoc(global) {
  'use strict';

  const RESPONSE_SELECTOR = '[data-conv-speaker="ai"]';
  const HUMAN_SELECTOR = '[data-conv-speaker="human"]';
  const EXPAND_HINT_RE = /已处理|已思考|搜索|思考|展开|更多|查看更多|查看全部|\+\s*\d+/i;
  const STRUCTURAL_EXPAND_RE = /clickable|expand|collapse|reveal|header/i;
  const FORBIDDEN_RE = /登录|captcha|验证码|风控|付款|支付|升级|会员|删除|重新生成|regenerate|外部|打开链接|新窗口/i;
  const MAX_DEPTH = 3;
  const MAX_CLICKS = 20;
  const SETTLE_MS = 600;
  const SETTLE_TIMEOUT_MS = 3_000;
  const PASSIVE_MODE_STORAGE_KEY = '__AI_GEO_YUANBAO_POC_PASSIVE__';
  const PASSIVE_SETTLE_MS = 1_500;
  const EVENT_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const RAW_RESPONSE_EVENT = '__AI_GEO_YUANBAO_POC_RESPONSE__';
  const RAW_RESPONSE_READY_EVENT = '__AI_GEO_YUANBAO_POC_READY__';
  const RESULT_EVENT = '__AI_GEO_YUANBAO_POC_RESULT__';
  const PROCESSING_ROOT_SELECTOR = '[data-version="v2"], [class*="agent-process-timeline"], [class*="hyc-component-deep-search-agent--v2"]';

  let mutationVersion = 0;
  let runInProgress = false;
  let scheduleTimer = null;
  let lastResult = null;
  const responseStates = new Map();
  const retryTimers = new Map();
  const rawTransports = [];
  const rawSearchOccurrences = [];
  let rawRecordSequence = 0;
  const passiveMode = (() => {
    try { return global.__AI_GEO_YUANBAO_POC_PASSIVE__ === true || global.sessionStorage.getItem(PASSIVE_MODE_STORAGE_KEY) === 'true'; } catch (_) { return global.__AI_GEO_YUANBAO_POC_PASSIVE__ === true; }
  })();

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function rawAcquisitionSnapshot() {
    const occurrences = rawSearchOccurrences.map((entry, index) => ({
      occurrence: index + 1,
      transport_index: entry.transport_index,
      path: entry.path,
      tool_call: entry.tool_call,
      query_items: entry.query_items || [],
      result_items: entry.result_items || [],
      query_count: (entry.query_items || []).reduce((sum, item) => sum + (item.bubbles || []).length, 0),
      result_count: (entry.result_items || []).reduce((sum, item) => sum + (item.bubbles || []).length, 0),
      link_count: (entry.result_items || []).flatMap((item) => item.bubbles || []).filter((bubble) => Object.prototype.hasOwnProperty.call(bubble, 'link') && Boolean(bubble.link)).length
    }));
    return {
      status: occurrences.length ? 'observed' : 'not_observed',
      transport_count: rawTransports.length,
      search_occurrence_count: occurrences.length,
      transports: rawTransports,
      occurrences
    };
  }

  function rawOnlyResult() {
    return {
      captured_at: new Date().toISOString(),
      page_url: global.location.href,
      conversation_url: currentConversationUrl(),
      prompt: '',
      response: null,
      observation_state: 'raw_acquisition_only',
      processing_trace: 'not_observed',
      processing_dom_status: 'not_observed',
      processing_counts: { query_count: null, result_card_count: null },
      steps: [],
      queries: [],
      cards: [],
      relationship: { type: 'unknown', reason: 'response_root_not_observed' },
      raw_acquisition: rawAcquisitionSnapshot(),
      passive_mode: passiveMode,
      manual_event_sequence: [],
      manual_before: null,
      manual_after: null,
      unknowns: ['Only public Search response fields and public DOM values are captured; hidden Chain-of-Thought is not inferred.'],
      export_format: 'yuanbao-raw-observation-poc'
    };
  }

  function publishUnifiedObservation(result) {
    const unifiedRuntime = global.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__;
    if (!unifiedRuntime || !result || typeof result !== 'object') return;
    const unifiedSession = unifiedRuntime.activatePlatform('yuanbao');
    if (!unifiedSession) return;
    const fingerprintSource = { ...result };
    delete fingerprintSource.captured_at;
    unifiedSession.publishObservation(result, JSON.stringify(fingerprintSource));
  }

  function publishResult(result) {
    try { global.document.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: JSON.stringify(result) })); } catch (_) {}
    publishUnifiedObservation(result);
  }

  function rawOccurrenceKey(entry) {
    return JSON.stringify({
      group_id: entry.tool_call?.groupId || entry.tool_call?.group_id || null,
      result_items: (entry.result_items || []).map((item) => ({ id: item.id || null, bubbles: item.bubbles || [] }))
    });
  }

  function rawOccurrenceQuality(entry) {
    return (entry.query_items || []).reduce((sum, item) => sum + (item.bubbles || []).length, 0);
  }

  function handleRawResponse(event) {
    let record;
    try { record = typeof event.detail === 'string' ? JSON.parse(event.detail) : null; } catch (_) { return; }
    if (!record?.transport) return;
    const transportIndex = rawTransports.push({
      index: rawTransports.length + 1,
      captured_at: record.captured_at || new Date().toISOString(),
      ...record.transport,
      search_data_status: record.search_data_status || 'not_observed'
    });
    for (const occurrence of record.search_occurrences || []) {
      const candidate = { ...occurrence, transport_index: transportIndex };
      const existingIndex = rawSearchOccurrences.findIndex((existing) => rawOccurrenceKey(existing) === rawOccurrenceKey(candidate));
      if (existingIndex < 0) rawSearchOccurrences.push(candidate);
      else if (rawOccurrenceQuality(candidate) > rawOccurrenceQuality(rawSearchOccurrences[existingIndex])) rawSearchOccurrences[existingIndex] = candidate;
    }
    if (global.document.querySelector(RESPONSE_SELECTOR)) schedule();
    else {
      global.__AI_GEO_YUANBAO_POC_LAST_RESULT__ = rawOnlyResult();
      publishResult(global.__AI_GEO_YUANBAO_POC_LAST_RESULT__);
    }
  }

  global.document.addEventListener(RAW_RESPONSE_EVENT, handleRawResponse);
  global.document.dispatchEvent(new CustomEvent(RAW_RESPONSE_READY_EVENT));

  function visible(element) {
    if (!element || typeof element.getClientRects !== 'function') return false;
    const style = global.getComputedStyle(element);
    return Boolean(element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden');
  }

  function attributes(element) {
    return Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]));
  }

  function domSummary(element) {
    if (!element || element.nodeType !== 1) return null;
    return {
      tagName: element.tagName,
      class: String(element.className || ''),
      role: element.getAttribute('role'),
      aria_expanded: element.getAttribute('aria-expanded'),
      text: clean(element.innerText || element.textContent).slice(0, 240)
    };
  }

  function domPath(element, boundary = null) {
    const path = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== boundary) {
      const siblings = current.parentElement ? [...current.parentElement.children] : [];
      path.unshift({ ...domSummary(current), child_index: Math.max(0, siblings.indexOf(current)) });
      current = current.parentElement;
    }
    if (boundary) path.unshift(domSummary(boundary));
    return path;
  }

  function nodeTree(element, depth = 0) {
    if (!element || depth > 20) return null;
    return {
      tag: element.tagName.toLowerCase(),
      attributes: attributes(element),
      visible: visible(element),
      text: clean(element.innerText || element.textContent),
      html: element.outerHTML,
      children: [...element.children].map((child) => nodeTree(child, depth + 1)).filter(Boolean)
    };
  }

  function responseKey(response, index) {
    return [response.getAttribute('data-message-id'), response.getAttribute('data-id'), response.id].find(Boolean) || `dom-index:${index}`;
  }

  function currentResponse() {
    const responses = [...global.document.querySelectorAll(RESPONSE_SELECTOR)].filter(visible);
    if (!responses.length) return null;
    return { element: responses[responses.length - 1], index: responses.length - 1, key: responseKey(responses[responses.length - 1], responses.length - 1) };
  }

  function currentConversationUrl(locationRef = global.location) {
    const href = locationRef?.href;
    if (typeof href !== 'string') return '';
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.hostname !== 'yuanbao.tencent.com') return '';
      if (!/^\/chat\/[^/]+\/[^/]+$/.test(url.pathname)) return '';
      return href;
    } catch (_error) {
      return '';
    }
  }

  function promptText(message) {
    const copy = message?.cloneNode(true);
    if (!copy) return '';
    copy.querySelectorAll('button, [role="button"]').forEach((control) => control.remove());
    return clean(copy.innerText || copy.textContent);
  }

  function singleTurnPrompt(response) {
    const messages = [...global.document.querySelectorAll('[data-conv-speaker]')].filter(visible);
    const humans = messages.filter((message) => message.matches(HUMAN_SELECTOR));
    const assistants = messages.filter((message) => message.matches(RESPONSE_SELECTOR));
    if (messages.length !== 2 || humans.length !== 1 || assistants.length !== 1 || assistants[0] !== response.element) return '';
    if (messages[0] !== humans[0] || messages[1] !== response.element) return '';
    return promptText(humans[0]);
  }

  function isProcessingRoot(element) {
    if (!element || !visible(element)) return false;
    const className = String(element.className || '');
    const structuralRoot = /agent-process-timeline/i.test(className)
      || /hyc-component-deep-search-agent--v2(?:\b|-)/i.test(className)
      || element.matches('[data-version="v2"]');
    if (!structuralRoot) return false;
    return true;
  }

  function processingRoot(response) {
    const candidates = [...response.querySelectorAll(PROCESSING_ROOT_SELECTOR)];
    return candidates.find(isProcessingRoot) || null;
  }

  function processingIdentity(processing) {
    const traceOwner = processing.closest('[data-trace-id]');
    return traceOwner?.getAttribute('data-trace-id') || [processing.getAttribute('data-version'), processing.className, processing.outerHTML.slice(0, 180)].join('|');
  }

  function passiveBeforeSnapshot(response, processing) {
    const target = processing.querySelector('[role="button"][aria-expanded="false"], button[aria-expanded="false"]');
    return {
      timestamp: new Date().toISOString(),
      response_root: { key: responseKey(response, 0), html: response.outerHTML, attributes: attributes(response) },
      processing_root: processing ? { html: processing.outerHTML, attributes: attributes(processing), descendant_count: processing.querySelectorAll('*').length, visible_descendant_count: [...processing.querySelectorAll('*')].filter(visible).length } : null,
      target_candidate: target ? { dom_path: domPath(target, processing), html: target.outerHTML } : null
    };
  }

  function attachPassiveDiagnostics(response, processing, stateForResponse) {
    if (!passiveMode || !processing || stateForResponse.passiveListenerAttached) return;
    stateForResponse.passiveListenerAttached = true;
    stateForResponse.manualEvents = [];
    stateForResponse.manualBefore = passiveBeforeSnapshot(response, processing);
    stateForResponse.manualAfter = null;
    stateForResponse.manualProcessing = processing;
    for (const type of EVENT_TYPES) {
      processing.addEventListener(type, (event) => {
        const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
        const record = {
          timestamp: new Date().toISOString(),
          event_type: type,
          is_trusted: event.isTrusted,
          target: domSummary(target),
          target_dom_path: domPath(target, processing),
          current_target: domSummary(event.currentTarget),
          composed_path: event.composedPath().filter((node) => node?.nodeType === 1).slice(0, 20).map(domSummary),
          client_x: typeof event.clientX === 'number' ? event.clientX : null,
          client_y: typeof event.clientY === 'number' ? event.clientY : null,
          button: typeof event.button === 'number' ? event.button : null,
          buttons: typeof event.buttons === 'number' ? event.buttons : null,
          default_prevented: event.defaultPrevented
        };
        stateForResponse.manualEvents.push(record);
        if (type === 'click') {
          if (stateForResponse.manualSettleTimer) global.clearTimeout(stateForResponse.manualSettleTimer);
          stateForResponse.manualSettleTimer = global.setTimeout(() => {
            const currentProcessing = processingRoot(response);
            stateForResponse.manualAfter = {
              timestamp: new Date().toISOString(),
              processing_root: currentProcessing ? { html: currentProcessing.outerHTML, attributes: attributes(currentProcessing), descendant_count: currentProcessing.querySelectorAll('*').length, visible_descendant_count: [...currentProcessing.querySelectorAll('*')].filter(visible).length } : null,
              response_html: response.outerHTML,
              aria_expanded_after: target?.getAttribute('aria-expanded') || null,
              url_after: global.location.href
            };
            console.info('[AI-GEO Yuanbao raw observation POC MANUAL_EVENT]', JSON.stringify({ response_key: responseKey(response, 0), events: stateForResponse.manualEvents, before: stateForResponse.manualBefore, after: stateForResponse.manualAfter }));
          }, PASSIVE_SETTLE_MS);
        }
      }, true);
    }
  }

  function responseState(key) {
    if (!responseStates.has(key)) {
      responseStates.set(key, {
        status: 'observed',
        clickCount: 0,
        depth: 0,
        retryCount: 0,
        actions: [],
        warnings: [],
        clickedCandidateIds: new Set(),
        processingIdentity: null,
        lastFingerprint: null
      });
    }
    return responseStates.get(key);
  }

  function safeExpandCandidate(element, processing) {
    if (!element || element.getAttribute('aria-expanded') !== 'false' || !processing.contains(element) || !visible(element)) return false;
    if (element.closest('a[href]') || element.hasAttribute('href')) return false;
    const text = clean(element.innerText || element.textContent);
    const label = clean(element.getAttribute('aria-label'));
    if (FORBIDDEN_RE.test(`${text} ${label}`)) return false;
    const className = String(element.className || '');
    const structuralControl = STRUCTURAL_EXPAND_RE.test(className) || element.tagName.toLowerCase() === 'button';
    const semanticHint = EXPAND_HINT_RE.test(`${text} ${label}`);
    if (!structuralControl && !semanticHint) return false;
    return element.getAttribute('role') === 'button' || element.tagName.toLowerCase() === 'button' || /header|expand|collapse|reveal/i.test(className);
  }

  function allExpandCandidates(processing) {
    return [...processing.querySelectorAll('[role="button"][aria-expanded="false"], button[aria-expanded="false"]')];
  }

  function candidateIdentity(element) {
    return [element.tagName.toLowerCase(), element.className, element.getAttribute('aria-label') || '', clean(element.innerText || element.textContent), element.getAttribute('data-testid') || ''].join('|');
  }

  function expandCandidates(processing, state) {
    return allExpandCandidates(processing)
      .filter((element) => safeExpandCandidate(element, processing))
      .filter((element) => !state.clickedCandidateIds.has(candidateIdentity(element)));
  }

  function unhandledCandidates(processing, state) {
    return allExpandCandidates(processing)
      .filter((element) => !safeExpandCandidate(element, processing))
      .filter((element) => !element.closest('a[href]') && !state.clickedCandidateIds.has(candidateIdentity(element)));
  }

  function elementMatchesHint(element, regex) {
    const className = String(element.className || '');
    const label = `${className} ${element.getAttribute('aria-label') || ''}`;
    return regex.test(label);
  }

  function extractNodes(processing, kind) {
    const regex = kind === 'query' ? /query|search|关键词|查询|搜索/i : /card|result|source|reference|引用|来源/i;
    return [...processing.querySelectorAll('*')]
      .filter((element) => visible(element) && elementMatchesHint(element, regex))
      .slice(0, 100)
      .map((element, index) => {
        const link = element.closest('a[href]') || element.querySelector('a[href]');
        const href = link?.href || element.getAttribute('href') || null;
        return {
          order: index + 1,
          tag: element.tagName.toLowerCase(),
          text: clean(element.innerText || element.textContent),
          href,
          html: element.outerHTML,
          attributes: attributes(element),
          domain: (() => { try { return href ? new URL(href, global.location.href).hostname : null; } catch (_) { return null; } })()
        };
      });
  }

  function linkObservations(root) {
    const links = [...root.querySelectorAll('a[href]')].map((anchor) => ({
      text: clean(anchor.innerText || anchor.textContent),
      href: anchor.href || anchor.getAttribute('href'),
      html: anchor.outerHTML,
      attributes: attributes(anchor)
    }));
    const plainUrls = clean(root.innerText || root.textContent).match(/https?:\/\/[^\s<]+/g) || [];
    return { anchors: links, plain_text_urls: [...new Set(plainUrls)] };
  }

  function materialization(element) {
    if (!element) return 'not_materialized';
    const className = String(element.className || '');
    if (/collapsed|hidden/i.test(className)) return 'not_materialized';
    return visible(element) ? 'materialized' : 'not_materialized';
  }

  function mapThinking(thinkingRoot, order) {
    const trigger = thinkingRoot.querySelector('[class*="thinkComponentTitle"], [data-agent-group-think-content] [role="button"]');
    const content = thinkingRoot.querySelector('[class*="thinkComponentContent"]');
    return {
      type: 'thinking',
      order,
      trigger: trigger ? { text: clean(trigger.innerText || trigger.textContent), aria_expanded: trigger.getAttribute('aria-expanded'), html: trigger.outerHTML, attributes: attributes(trigger) } : null,
      content: content ? { materialization: materialization(content), text: clean(content.innerText || content.textContent), html: content.outerHTML, attributes: attributes(content), links: linkObservations(content) } : { materialization: 'not_materialized', text: '', html: null, attributes: {}, links: { anchors: [], plain_text_urls: [] } },
      html: thinkingRoot.outerHTML,
      attributes: attributes(thinkingRoot)
    };
  }

  function mapSearch(searchRoot, order) {
    const trigger = searchRoot.querySelector('[class*="childHead"], [role="button"][aria-expanded]');
    const queryContainer = searchRoot.querySelector('[class*="query"], [data-query], [class*="keyword"]');
    const resultContainer = searchRoot.querySelector('[class*="result"], [class*="card"], [class*="source"]');
    const revealControls = [...searchRoot.querySelectorAll('[role="button"], button')]
      .filter((node) => /\+\s*\d+|收起/.test(clean(node.innerText || node.textContent)))
      .map((node) => ({ label: clean(node.innerText || node.textContent), aria_expanded: node.getAttribute('aria-expanded'), html: node.outerHTML, attributes: attributes(node) }));
    const queryNodes = [...searchRoot.querySelectorAll('[class*="query"], [data-query], [class*="keyword"]')]
      .filter((node) => visible(node))
      .map((node, index) => ({ index: index + 1, text: clean(node.innerText || node.textContent), html: node.outerHTML, attributes: attributes(node) }));
    const cardNodes = [...searchRoot.querySelectorAll('[class*="card"], [class*="result"], [class*="source"]')]
      .filter((node) => visible(node))
      .map((node, index) => {
        const anchor = node.matches('a[href]') ? node : node.querySelector('a[href]');
        const href = anchor?.href || null;
        return { order: index + 1, title: clean(node.querySelector('[class*="title"], h1, h2, h3')?.innerText || ''), text: clean(node.innerText || node.textContent), site_label: clean(node.querySelector('[class*="source"], [class*="site"], [class*="domain"]')?.innerText || '') || null, href, domain: href ? (() => { try { return new URL(href).hostname; } catch (_) { return null; } })() : null, html: node.outerHTML, attributes: attributes(node) };
      });
    return {
      type: 'search',
      order,
      trigger: trigger ? { text: clean(trigger.innerText || trigger.textContent), aria_expanded: trigger.getAttribute('aria-expanded'), html: trigger.outerHTML, attributes: attributes(trigger) } : null,
      queries: queryNodes.length ? queryNodes : [],
      result_cards: cardNodes.length ? cardNodes : [],
      query_materialization: queryNodes.length ? 'materialized' : 'not_materialized / not_manually_expanded',
      result_materialization: cardNodes.length ? 'materialized' : 'not_materialized / not_manually_expanded',
      reveal: { controls: revealControls, additional_cards: null },
      html: searchRoot.outerHTML,
      attributes: attributes(searchRoot)
    };
  }

  function mapGroup(groupRoot, order) {
    const header = groupRoot.querySelector('[class*="groupHeader"], [role="button"][aria-expanded]');
    const thinkingNodes = groupRoot.querySelectorAll('[class*="groupThinkItem"]');
    const children = [...groupRoot.querySelectorAll('[class*="child__"]'), ...([...thinkingNodes].length ? [...thinkingNodes] : [...groupRoot.querySelectorAll('[data-agent-group-think-content]')])]
      .filter((node) => node.matches('[class*="child__"]') || /groupThinkItem|data-agent-group-think-content/.test(String(node.className || '') + ' ' + [...node.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' ')))
      .slice(0, 20)
      .map((node, index) => /groupThinkItem|data-agent-group-think-content/.test(String(node.className || '') + ' ' + [...node.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' ')) ? mapThinking(node, index + 1) : mapSearch(node, index + 1));
    return {
      type: 'group',
      order,
      summary: clean(header?.innerText || header?.textContent || groupRoot.innerText || groupRoot.textContent),
      root: { html: groupRoot.outerHTML, attributes: attributes(groupRoot) },
      header: header ? { role: header.getAttribute('role'), aria_expanded: header.getAttribute('aria-expanded'), class: String(header.className || ''), text: clean(header.innerText || header.textContent), html: header.outerHTML, attributes: attributes(header) } : null,
      children
    };
  }

  function extractProcessingMapping(processing) {
    if (!processing) return null;
    const items = [...processing.children].map((item, index) => {
      const className = String(item.className || '');
      if (/group__/.test(className)) return mapGroup(item, index + 1);
      if (/textComponent/.test(className)) return { type: 'text', order: index + 1, text: clean(item.innerText || item.textContent), html: item.outerHTML, attributes: attributes(item) };
      return { type: 'unknown', order: index + 1, text: clean(item.innerText || item.textContent), html: item.outerHTML, attributes: attributes(item) };
    });
    const groups = items.filter((item) => item.type === 'group');
    const thinkingSections = groups.flatMap((item) => item.children || []).filter((child) => child.type === 'thinking');
    const searchSections = groups.flatMap((item) => item.children || []).filter((child) => child.type === 'search');
    const queries = searchSections.flatMap((search) => search.queries);
    const cards = searchSections.flatMap((search) => search.result_cards);
    const revealControls = searchSections.flatMap((search) => search.reveal.controls);
    const searchDetailsMaterialized = searchSections.length > 0 && searchSections.every((search) => search.query_materialization === 'materialized' && search.result_materialization === 'materialized');
    const thinkingDetailsMaterialized = thinkingSections.every((thinking) => thinking.content.materialization === 'materialized');
    const notMaterialized = 'not_materialized / not_manually_expanded';
    return {
      summary: clean(processing.innerText || processing.textContent).split(/\s+/).slice(0, 20).join(' '),
      root: { html: processing.outerHTML, attributes: attributes(processing), dom_version: processing.getAttribute('data-version') },
      items,
      order_evidence: 'direct child order of the Processing root',
      counts: {
        processing_item_total: items.length,
        group_items: items.filter((item) => item.type === 'group').length,
        text_items: items.filter((item) => item.type === 'text').length,
        thinking_sections: thinkingSections.length,
        thinking_content_characters: thinkingDetailsMaterialized ? thinkingSections.reduce((sum, thinking) => sum + thinking.content.text.length, 0) : notMaterialized,
        search_sections: searchSections.length,
        query_count: searchDetailsMaterialized ? queries.length : notMaterialized,
        result_card_count: searchDetailsMaterialized ? cards.length : notMaterialized,
        cards_with_href: searchDetailsMaterialized ? cards.filter((card) => card.href).length : notMaterialized,
        cards_with_title: searchDetailsMaterialized ? cards.filter((card) => card.title).length : notMaterialized,
        cards_with_site_label: searchDetailsMaterialized ? cards.filter((card) => card.site_label).length : notMaterialized,
        reveal_count: searchDetailsMaterialized ? revealControls.length : notMaterialized,
        additional_cards: notMaterialized,
        thinking_content_links: thinkingDetailsMaterialized ? thinkingSections.reduce((sum, thinking) => sum + thinking.content.links.anchors.length + thinking.content.links.plain_text_urls.length, 0) : notMaterialized
      },
      unknowns: ['Queries, result cards, +N additions, and complete thinking text remain not materialized when their inner controls are collapsed.']
    };
  }

  function processingSnapshot(response, processing, before, after, state) {
    if (!processing) return {
      processing_trace: 'absent',
      processing_dom_status: 'not_observed',
      processing_counts: { query_count: null, result_card_count: null },
      processing: null,
      steps: [],
      queries: [],
      cards: [],
      relationship: { type: 'unknown', reason: 'no_processing_root' }
    };
    const controls = [...processing.querySelectorAll('[role="button"][aria-expanded], button[aria-expanded]')];
    return {
      processing_trace: 'present',
      processing_dom_status: 'observed',
      processing: {
        visible_status: clean([...processing.querySelectorAll('*')].find((node) => clean(node.innerText || node.textContent) === '已处理')?.innerText || ''),
        summary: clean(processing.querySelector('[class*="groupTitle"], [class*="groupHeader"]')?.innerText || processing.innerText),
        html: processing.outerHTML,
        attributes: attributes(processing),
        dom_version: processing.getAttribute('data-version'),
        before,
        after,
        dom_hierarchy: nodeTree(processing),
        controls: controls.map((control) => ({ aria_expanded: control.getAttribute('aria-expanded'), text: clean(control.innerText || control.textContent), attributes: attributes(control) }))
      },
      steps: [...processing.querySelectorAll('[class*="timeline"], [class*="step"], [class*="group"]')].filter(visible).slice(0, 100).map((element, index) => ({ order: index + 1, text: clean(element.innerText || element.textContent), html: element.outerHTML, attributes: attributes(element), children: [...element.children].map((child) => ({ tag: child.tagName.toLowerCase(), text: clean(child.innerText || child.textContent), html: child.outerHTML, attributes: attributes(child) })) })),
      queries: extractNodes(processing, 'query'),
      cards: extractNodes(processing, 'card'),
      relationship: { type: 'dom_parent_child', evidence: 'processing root contains the captured steps, queries, and cards' },
      processing_counts: {
        query_count: null,
        result_card_count: null,
        note: 'DOM counts are null unless the existing DOM mapper materializes a recognized query/result collection.'
      },
      expansion_actions: state.actions,
      warnings: state.warnings
    };
  }

  function state(processing) {
    if (!processing) return null;
    const descendants = [...processing.querySelectorAll('*')];
    return {
      aria_expanded: [...processing.querySelectorAll('[role="button"][aria-expanded], button[aria-expanded]')].map((node) => node.getAttribute('aria-expanded')),
      descendant_count: descendants.length,
      visible_descendant_count: descendants.filter(visible).length,
      html_length: processing.outerHTML.length
    };
  }

  function waitForSettle(startVersion) {
    return new Promise((resolve) => {
      const started = Date.now();
      let stableSince = Date.now();
      let observedVersion = mutationVersion;
      const timer = global.setInterval(() => {
        if (mutationVersion !== observedVersion) { observedVersion = mutationVersion; stableSince = Date.now(); }
        if (Date.now() - stableSince >= SETTLE_MS || Date.now() - started >= SETTLE_TIMEOUT_MS) {
          global.clearInterval(timer);
          resolve({ mutation_observed: mutationVersion !== startVersion, mutation_version: mutationVersion });
        }
      }, 50);
    });
  }

  function scheduleRetry(responseKey) {
    if (retryTimers.has(responseKey)) return;
    const timer = global.setTimeout(() => {
      retryTimers.delete(responseKey);
      schedule();
    }, SETTLE_MS);
    retryTimers.set(responseKey, timer);
  }

  async function runObservation() {
    if (runInProgress) return;
    const current = currentResponse();
    if (!current) return;
    const stateForResponse = responseState(current.key);
    const processing = processingRoot(current.element);
    const fingerprint = JSON.stringify({ key: current.key, outputting: current.element.getAttribute('data-conv-outputting'), processing: processing?.outerHTML.slice(0, 1000) || null });
    if (stateForResponse.status === 'expansion_complete' && stateForResponse.lastFingerprint === fingerprint) return;
    if (stateForResponse.status === 'expansion_failed' && stateForResponse.lastFingerprint === fingerprint) return;
    runInProgress = true;
    try {
      const before = state(processing);
      let activeProcessing = processing;
      if (!activeProcessing) {
        stateForResponse.status = 'processing_absent';
        stateForResponse.lastFingerprint = fingerprint;
      } else {
        attachPassiveDiagnostics(current.element, activeProcessing, stateForResponse);
        stateForResponse.processingIdentity = processingIdentity(activeProcessing);
        stateForResponse.status = stateForResponse.status === 'expansion_in_progress' ? stateForResponse.status : 'processing_present';
        for (let depth = stateForResponse.depth; !passiveMode && depth < MAX_DEPTH && stateForResponse.clickCount < MAX_CLICKS; depth += 1) {
          const candidate = expandCandidates(activeProcessing, stateForResponse)[0];
          if (!candidate) break;
          const candidateId = candidateIdentity(candidate);
          const action = {
            timestamp: new Date().toISOString(),
            response_identity: current.key,
            processing_identity: stateForResponse.processingIdentity,
            candidate: { selector: '[role="button"][aria-expanded="false"]', tag: candidate.tagName.toLowerCase(), class: String(candidate.className || ''), text: clean(candidate.innerText || candidate.textContent) },
            depth: depth + 1,
            aria_expanded_before: candidate.getAttribute('aria-expanded'),
            click_attempted: false,
            click_result: null,
            aria_expanded_after: null,
            dom_mutation_observed: false,
            warning: null
          };
          stateForResponse.status = 'expansion_in_progress';
          const startVersion = mutationVersion;
          action.click_attempted = true;
          try {
            candidate.click();
            action.click_result = 'clicked';
          } catch (error) {
            action.click_result = 'error';
            action.warning = error.message;
            stateForResponse.warnings.push('expand_click_error');
            stateForResponse.actions.push(action);
            stateForResponse.status = 'expansion_failed';
            break;
          }
          const settled = await waitForSettle(startVersion);
          action.aria_expanded_after = candidate.getAttribute('aria-expanded');
          action.dom_mutation_observed = settled.mutation_observed;
          stateForResponse.actions.push(action);
          stateForResponse.clickedCandidateIds.add(candidateId);
          stateForResponse.clickCount += 1;
          stateForResponse.depth = depth + 1;
          activeProcessing = processingRoot(current.element);
          if (!activeProcessing) break;
        }
        if (passiveMode) {
          stateForResponse.status = 'passive_observation';
        } else if (activeProcessing && stateForResponse.status !== 'expansion_failed') {
          const remainingSafe = expandCandidates(activeProcessing, stateForResponse);
          const unknownCandidates = unhandledCandidates(activeProcessing, stateForResponse);
          if (unknownCandidates.length) {
            if (!stateForResponse.warnings.includes('unhandled_expand_candidate')) stateForResponse.warnings.push('unhandled_expand_candidate');
          }
          if (remainingSafe.length && (stateForResponse.depth >= MAX_DEPTH || stateForResponse.clickCount >= MAX_CLICKS)) {
            stateForResponse.status = 'expansion_failed';
            if (!stateForResponse.warnings.includes('expansion_bound_reached')) stateForResponse.warnings.push('expansion_bound_reached');
          } else if (remainingSafe.length) {
            stateForResponse.status = 'expansion_pending';
          } else if (current.element.getAttribute('data-conv-outputting') === 'false') {
            stateForResponse.status = 'expansion_complete';
          } else {
            stateForResponse.status = 'expansion_pending';
            stateForResponse.retryCount += 1;
            if (stateForResponse.retryCount <= 60) scheduleRetry(current.key);
          }
        }
      }
      const after = state(activeProcessing);
      stateForResponse.lastFingerprint = fingerprint;
      lastResult = {
        captured_at: new Date().toISOString(),
        page_url: global.location.href,
        conversation_url: currentConversationUrl(),
        prompt: singleTurnPrompt(current),
        response: { key: current.key, attributes: attributes(current.element), html: current.element.outerHTML },
        observation_state: stateForResponse.status,
        ...processingSnapshot(current.element, activeProcessing, before, after, stateForResponse),
        structured_processing: extractProcessingMapping(activeProcessing),
        raw_acquisition: rawAcquisitionSnapshot(),
        passive_mode: passiveMode,
        manual_event_sequence: stateForResponse.manualEvents || [],
        manual_before: stateForResponse.manualBefore || null,
        manual_after: stateForResponse.manualAfter || null,
        unknowns: ['Only public DOM values are captured; hidden Chain-of-Thought is not inferred.'],
        export_format: 'yuanbao-raw-observation-poc'
      };
      global.__AI_GEO_YUANBAO_POC_LAST_RESULT__ = lastResult;
      publishResult(lastResult);
      console.info('[AI-GEO Yuanbao raw observation POC]', JSON.stringify(lastResult));
    } finally {
      runInProgress = false;
    }
  }

  function schedule() {
    if (scheduleTimer !== null) global.clearTimeout(scheduleTimer);
    scheduleTimer = global.setTimeout(() => { scheduleTimer = null; runObservation(); }, 200);
  }

  const observer = new MutationObserver(() => { mutationVersion += 1; schedule(); });
  if (global.document.documentElement) observer.observe(global.document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'data-conv-outputting'] });

  global.__AI_GEO_YUANBAO_POC__ = Object.freeze({
    capture: () => lastResult,
    export: () => JSON.stringify(lastResult, null, 2)
  });
  global.__AI_GEO_YUANBAO_POC_LAST_RESULT__ = null;
  schedule();
})(globalThis);
