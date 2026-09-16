(function installDoubaoReadOnlySpike(global) {
  'use strict';

  const SUMMARY_RE = /搜索\s*(\d+)\s*个关键词\s*[,，]?\s*参考\s*(\d+)\s*篇资料/;
  const MUTATION_DEBOUNCE_MS = 200;
  const RESULT_STABLE_MS = 1_000;
  const MAX_ANCESTOR_DEPTH = 8;
  const RESPONSE_PROBE_NAMESPACE = 'AI_GEO_DOUBAO_RESPONSE_PROBE';
  const RESPONSE_PROBE_REQUEST = 'REQUEST_SNAPSHOT';
  const RESPONSE_PROBE_RESPONSE = 'RESPONSE_SNAPSHOT';
  const ITEM_SELECTOR = 'li, article, [role="listitem"], [role="option"], [data-index], [data-order]';
  const LIST_SELECTOR = 'ul, ol, [role="list"], [role="listbox"], [role="group"]';
  const AUXILIARY_LABEL_RE = /^(?:思考|深度思考|思考中|thinking|reasoning|processing|处理中|生成中)$/i;

  function textOf(element) {
    return String(element?.innerText || element?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisible(element) {
    if (!element || typeof element.getClientRects !== 'function') return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const style = global.getComputedStyle(element);
    return Boolean(
      element.getClientRects().length &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  }

  function attributesOf(element) {
    return Object.fromEntries([...element.attributes].map((attribute) => [attribute.name, attribute.value]));
  }

  function classNameOf(element) {
    return typeof element.className === 'string' ? element.className : '';
  }

  function compactNode(element) {
    if (!element) return null;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      class: classNameOf(element),
      role: element.getAttribute('role'),
      aria_label: element.getAttribute('aria-label'),
      text: textOf(element).slice(0, 500)
    };
  }

  function ancestorChain(element) {
    const chain = [];
    let current = element?.parentElement || null;
    let depth = 0;
    while (current && depth < MAX_ANCESTOR_DEPTH) {
      chain.push(compactNode(current));
      current = current.parentElement;
      depth += 1;
    }
    return chain;
  }

  function siblingStructure(element) {
    const parent = element?.parentElement;
    if (!parent) return [];
    return [...parent.children].map((sibling, index) => ({
      index,
      tag: sibling.tagName.toLowerCase(),
      id: sibling.id || null,
      class: classNameOf(sibling),
      role: sibling.getAttribute('role'),
      text: textOf(sibling).slice(0, 300)
    }));
  }

  function clickableNodes(root) {
    return [...root.querySelectorAll('a, button, [role="button"], [role="link"], [tabindex]')]
      .map(compactNode)
      .slice(0, 100);
  }

  function nodeDescriptor(element, { includeHtml = true } = {}) {
    if (!element) return null;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      class: classNameOf(element),
      role: element.getAttribute('role'),
      attributes: attributesOf(element),
      visible: isVisible(element),
      text: textOf(element),
      outerHTML: includeHtml ? element.outerHTML : null,
      ancestor_chain: ancestorChain(element),
      sibling_structure: siblingStructure(element),
      descendant_count: element.querySelectorAll('*').length,
      clickable_nodes: clickableNodes(element)
    };
  }

  function allElements(root) {
    return root ? [root, ...root.querySelectorAll('*')] : [];
  }

  function isSidebarElement(element) {
    return Boolean(element?.closest('#flow_chat_sidebar'));
  }

  function isNavigationElement(element) {
    if (!element || isSidebarElement(element)) return true;
    const navigation = element.closest('nav, [role="navigation"]');
    if (navigation) return true;
    const conversationItem = element.closest('[data-conversation-id]');
    return Boolean(conversationItem && (
      conversationItem.tagName === 'A' ||
      conversationItem.getAttribute('role') === 'link' ||
      conversationItem.getAttribute('role') === 'listitem'
    ));
  }

  function isHeaderRegion(element) {
    const nodes = element ? [element, ...ancestorElements(element)] : [];
    return nodes.some((node) => {
      if (node.tagName === 'HEADER') return true;
      const marker = [node.tagName, ...[...node.attributes].map((attribute) => `${attribute.name}=${attribute.value}`)].join(' ');
      return /(?:^|[-_ ])header(?:[-_ ]|$)|top[-_ ]?nav|navbar/i.test(marker);
    });
  }

  function isExcludedConversationChrome(element) {
    return isSidebarElement(element) || isNavigationElement(element) || isHeaderRegion(element);
  }

  function semanticMarker(element) {
    const nodes = element ? [element, ...ancestorElements(element).slice(0, 5)] : [];
    return nodes
      .map((node) => [node.tagName, node.id, classNameOf(node), ...[...node.attributes].map((attribute) => `${attribute.name}=${attribute.value}`)].join(' '))
      .join(' ');
  }

  function isBeforeElement(element, reference) {
    return Boolean(reference && (element.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_FOLLOWING));
  }

  function isAfterElement(element, reference) {
    return Boolean(reference && (element.compareDocumentPosition(reference) & Node.DOCUMENT_POSITION_PRECEDING));
  }

  function hasUserMessageSemantics(element) {
    if (roleKind(element) === 'user') return true;
    const marker = semanticMarker(element);
    return /(?:user|human|send|bubble|outgoing|justify-end|self-end|message)/i.test(marker);
  }

  function hasAnswerSemantics(element) {
    if (roleKind(element) === 'assistant') return true;
    const marker = semanticMarker(element);
    return element.tagName === 'ARTICLE' || /(?:assistant|answer|response|markdown|md-box|prose|message|content)/i.test(marker);
  }

  function isActionOrReferenceElement(element) {
    return element.matches('a, button, input, textarea, [role="button"], [role="link"]') ||
      Boolean(element.querySelector('button, [role="button"], input, textarea'));
  }

  function answerContentRoot(element) {
    if (!element) return null;
    const candidates = [element, ...element.querySelectorAll('article, section, div, p')]
      .filter((candidate) => {
        const text = textOf(candidate);
        return text.length >= 2 &&
          !isExcludedConversationChrome(candidate) &&
          !SUMMARY_RE.test(text) &&
          !isActionOrReferenceElement(candidate) &&
          hasAnswerSemantics(candidate);
      });
    return candidates.sort((left, right) => textOf(right).length - textOf(left).length)[0] || null;
  }

  function matchingSummary(element) {
    const text = textOf(element);
    const match = text.match(SUMMARY_RE);
    return match ? { text, queryCount: Number(match[1]), referenceCount: Number(match[2]) } : null;
  }

  function findSummary(documentRef) {
    const candidates = allElements(documentRef.body)
      .filter(isVisible)
      .filter((element) => !isSidebarElement(element))
      .map((element) => ({ element, parsed: matchingSummary(element) }))
      .filter((candidate) => candidate.parsed);
    candidates.sort((left, right) => {
      const leftExact = left.parsed.text === left.element.textContent.trim();
      const rightExact = right.parsed.text === right.element.textContent.trim();
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return left.element.querySelectorAll('*').length - right.element.querySelectorAll('*').length;
    });
    return candidates[0] || null;
  }

  function expandedState(summaryElement) {
    const candidates = [
      summaryElement,
      ...ancestorElements(summaryElement),
      ...[...summaryElement.querySelectorAll('button, [role="button"], [aria-expanded]')]
    ];
    const withState = candidates.find((element) => ['true', 'false'].includes(element?.getAttribute('aria-expanded')));
    if (!withState) return 'unknown';
    return withState.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
  }

  function ancestorElements(element) {
    const result = [];
    let current = element?.parentElement || null;
    let depth = 0;
    while (current && depth < MAX_ANCESTOR_DEPTH) {
      result.push(current);
      current = current.parentElement;
      depth += 1;
    }
    return result;
  }

  function probeScope(summaryElement) {
    const toggle = [summaryElement, ...ancestorElements(summaryElement)]
      .find((element) => element.hasAttribute('aria-expanded') || /^(BUTTON|SUMMARY)$/.test(element.tagName) || element.getAttribute('role') === 'button');
    if (toggle?.parentElement) return toggle.parentElement;
    return summaryElement.parentElement || summaryElement;
  }

  function findChatScope(documentRef, summaryElement) {
    const mainRoots = [...documentRef.body.querySelectorAll('main, [role="main"]')]
      .filter((element) => !isSidebarElement(element));
    if (mainRoots.length) {
      const containingMain = summaryElement && mainRoots.find((element) => element.contains(summaryElement));
      return containingMain || mainRoots[mainRoots.length - 1];
    }

    const ancestors = summaryElement ? [summaryElement, ...ancestorElements(summaryElement)] : [];
    const semanticAncestor = ancestors.find((element) => {
      if (isSidebarElement(element)) return false;
      const marker = [...element.attributes]
        .map((attribute) => `${attribute.name}=${attribute.value}`)
        .join(' ');
      return /(?:chat|conversation|message|content|main)/i.test(marker);
    });
    return semanticAncestor || documentRef.body;
  }

  function directListItems(list) {
    return [...list.querySelectorAll(ITEM_SELECTOR)].filter((item) => {
      const nearestList = item.closest(LIST_SELECTOR);
      if (nearestList !== list) return false;
      const parentItem = item.parentElement?.closest(ITEM_SELECTOR);
      return !parentItem || !list.contains(parentItem);
    });
  }

  function hrefProbe(item) {
    const urls = [];
    const sources = [];
    const add = (url, source) => {
      const value = String(url || '').trim();
      if (!value || urls.includes(value)) return;
      urls.push(value);
      sources.push(source);
    };
    if (item.matches('a[href]')) add(item.getAttribute('href'), 'self_anchor');
    [...item.querySelectorAll('a[href]')].forEach((anchor) => add(anchor.getAttribute('href'), 'descendant_anchor'));
    const ancestorAnchor = item.closest('a[href]');
    if (ancestorAnchor && ancestorAnchor !== item) add(ancestorAnchor.getAttribute('href'), 'ancestor_anchor');
    [...item.attributes].forEach((attribute) => {
      if (/(?:^|[-_])(href|url|link|source)(?:$|[-_])/i.test(attribute.name)) add(attribute.value, `attribute:${attribute.name}`);
    });
    return { direct_url: urls[0] || null, urls, sources };
  }

  function itemFields(item) {
    const text = textOf(item);
    const directFields = {};
    [...item.attributes].forEach((attribute) => {
      if (/^(?:data-|aria-|title$|alt$|href$|role$)/i.test(attribute.name)) {
        directFields[attribute.name] = attribute.value;
      }
    });
    return {
      text,
      tag: item.tagName.toLowerCase(),
      role: item.getAttribute('role'),
      attributes: attributesOf(item),
      direct_fields: directFields,
      icon_candidates: [...item.querySelectorAll('img, svg, [role="img"]')].map(compactNode).slice(0, 20),
      href_probe: hrefProbe(item),
      outerHTML: item.outerHTML,
      visible: isVisible(item)
    };
  }

  function listGroups(scope) {
    return [...scope.querySelectorAll(LIST_SELECTOR)].map((list) => ({
      list,
      items: directListItems(list)
    })).filter((group) => group.items.length > 0);
  }

  function itemHasReferenceSignal(item) {
    const text = textOf(item);
    return Boolean(
      hrefProbe(item).urls.length ||
      /^\s*\d+\s*[.、)）:：-]/.test(text) ||
      [...item.attributes].some((attribute) => /(?:index|order|source|reference|url|link)/i.test(attribute.name))
    );
  }

  function materializedInventory(scope, expectedQueryCount, expectedReferenceCount) {
    const groups = listGroups(scope);
    const referenceGroup = groups
      .filter((group) => group.items.some(itemHasReferenceSignal))
      .sort((left, right) => {
        const leftExpected = left.items.length === expectedReferenceCount;
        const rightExpected = right.items.length === expectedReferenceCount;
        if (leftExpected !== rightExpected) return leftExpected ? -1 : 1;
        return right.items.length - left.items.length;
      })[0] || null;
    const queryGroup = groups
      .filter((group) => group !== referenceGroup)
      .sort((left, right) => {
        const leftExpected = left.items.length === expectedQueryCount;
        const rightExpected = right.items.length === expectedQueryCount;
        if (leftExpected !== rightExpected) return leftExpected ? -1 : 1;
        return Math.abs(left.items.length - expectedQueryCount) - Math.abs(right.items.length - expectedQueryCount);
      })[0] || null;

    const queries = queryGroup ? queryGroup.items.map((item, index) => ({ order: index + 1, ...itemFields(item) })) : null;
    const references = referenceGroup ? referenceGroup.items.map((item, index) => ({ order: index + 1, ...itemFields(item) })) : null;
    return {
      queries_materialized: queryGroup ? queries.length > 0 : false,
      references_materialized: referenceGroup ? references.length > 0 : false,
      queries,
      references,
      list_inventory: groups.map((group) => ({
        item_count: group.items.length,
        visible_item_count: group.items.filter(isVisible).length,
        outerHTML: group.list.outerHTML
      }))
    };
  }

  function roleKind(element) {
    const attrs = [...element.attributes];
    for (const attribute of attrs) {
      const key = attribute.name.toLowerCase();
      const value = attribute.value.toLowerCase();
      if (!/(role|author|speaker|message|sender|actor)/.test(key)) continue;
      if (/^(user|human|用户|提问者|question)$/.test(value) || /(?:^|[-_ ])(?:user|human|用户)(?:$|[-_ ])/i.test(value)) return 'user';
      if (/^(assistant|ai|bot|model|机器人|助手)$/.test(value) || /(?:^|[-_ ])(?:assistant|ai|bot|model|助手)(?:$|[-_ ])/i.test(value)) return 'assistant';
    }
    return null;
  }

  function leafRoleCandidates(scope, kind) {
    const candidates = allElements(scope)
      .filter((element) => !isExcludedConversationChrome(element))
      .filter((element) => roleKind(element) === kind && textOf(element));
    return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  }

  function fallbackTextCandidates(scope, { beforeElement = null, afterElement = null } = {}) {
    const candidates = allElements(scope)
      .filter((element) => /^(MAIN|ARTICLE|SECTION|DIV|P|LI)$/.test(element.tagName))
      .filter((element) => isVisible(element) && textOf(element).length >= 2 && textOf(element).length <= 2_000)
      .filter((element) => !isExcludedConversationChrome(element))
      .filter((element) => !element.querySelector('input, textarea, [contenteditable="true"]'))
      .filter((element) => !beforeElement || isBeforeElement(element, beforeElement))
      .filter((element) => !afterElement || isAfterElement(element, afterElement));
    return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other) && textOf(other) === textOf(element)));
  }

  function candidateDescriptor(element, occurrence) {
    return { occurrence, ...nodeDescriptor(element) };
  }

  function isQuestionMetadataElement(element) {
    if (!element) return false;
    if (element.matches('time, [datetime]')) return true;
    const marker = semanticMarker(element);
    return /(?:timestamp|metadata|message[-_ ]?action|action[-_ ]?bar)/i.test(marker) ||
      (element.querySelector('time[datetime], [datetime]') && /(?:time|meta|action|bar)/i.test(marker));
  }

  function userMessageBodyScore(element) {
    if (!element || isQuestionMetadataElement(element)) return -1;
    if (roleKind(element) === 'user') return 4;
    const marker = semanticMarker(element);
    if (/(?:bg[-_ ]?g[-_ ]?send[-_ ]?msg[-_ ]?bubble|send[-_ ]?msg[-_ ]?bubble|user[-_ ]?(?:message|bubble)|message[-_ ]?content|outgoing)/i.test(marker)) return 3;
    if (/(?:justify-end|self-end)/i.test(marker)) return 1;
    return 0;
  }

  function selectQuestionMessageBodies(candidates) {
    let bodies = candidates.filter((element) => !isQuestionMetadataElement(element));
    const stronglyScoped = bodies.filter((element) => userMessageBodyScore(element) >= 3);
    if (stronglyScoped.length) bodies = stronglyScoped;

    // A bubble wrapper can gain metadata text after the body is mounted. Keep
    // the semantic body candidate and discard its containing wrappers.
    return bodies.filter((element) => !bodies.some((other) => (
      other !== element && element.contains(other)
    )));
  }

  function discoverQuestion(scope, summaryElement) {
    let candidates = leafRoleCandidates(scope, 'user');
    let status = candidates.length === 1 ? 'confirmed' : candidates.length ? 'candidate' : 'unknown';
    if (!candidates.length) {
      candidates = fallbackTextCandidates(scope, { beforeElement: summaryElement }).filter((element) => {
        const text = textOf(element);
        return !SUMMARY_RE.test(text) && !/搜索\s*\d+\s*个关键词/.test(text) && hasUserMessageSemantics(element);
      }).sort((left, right) => {
        const leftScore = hasUserMessageSemantics(left) ? 1 : 0;
        const rightScore = hasUserMessageSemantics(right) ? 1 : 0;
        return rightScore - leftScore;
      });
      candidates = selectQuestionMessageBodies(candidates);
      status = candidates.length ? 'candidate' : 'unknown';
      if (candidates.length === 1) status = 'confirmed';
    }
    const described = candidates.map((element, index) => candidateDescriptor(element, index + 1));
    const selected = status === 'confirmed' ? described[0] : null;
    return {
      status,
      text: selected?.text || '',
      occurrence: selected?.occurrence || null,
      candidates: described
    };
  }

  function answerCandidatesAfterSummary(scope, summaryElement) {
    let current = summaryElement;
    while (current?.parentElement) {
      const parent = current.parentElement;
      const siblings = [...parent.children];
      const currentIndex = siblings.indexOf(current);
      const after = siblings.slice(currentIndex + 1).filter((element) => {
        const text = textOf(element);
        return text.length >= 2 &&
          !isExcludedConversationChrome(element) &&
          !SUMMARY_RE.test(text);
      }).map(answerContentRoot).filter(Boolean);
      if (after.length) return after;
      current = parent;
    }

    return fallbackTextCandidates(scope, { afterElement: summaryElement })
      .filter((element) => !SUMMARY_RE.test(textOf(element)) && hasAnswerSemantics(element));
  }

  function discoverAnswer(scope, summaryElement, questionCandidates) {
    let candidates = summaryElement ? answerCandidatesAfterSummary(scope, summaryElement) : [];
    if (!candidates.length) candidates = leafRoleCandidates(scope, 'assistant').map(answerContentRoot).filter(Boolean);
    let status = candidates.length === 1 ? 'confirmed' : candidates.length ? 'candidate' : 'unknown';
    if (!candidates.length) {
      candidates = answerCandidatesAfterSummary(scope, summaryElement)
        .filter((element) => !questionCandidates.some((candidate) => candidate === element))
        .filter((element) => textOf(element) !== textOf(summaryElement));
      status = candidates.length ? 'candidate' : 'unknown';
      if (candidates.length === 1) status = 'confirmed';
    }
    const selectedElement = candidates[candidates.length - 1] || null;
    const selected = selectedElement ? nodeDescriptor(selectedElement) : null;
    return {
      status,
      text: selected?.text || '',
      html: selected?.outerHTML || '',
      root: selected,
      element: selectedElement,
      occurrence: selectedElement ? candidates.indexOf(selectedElement) + 1 : null,
      candidate_count: candidates.length,
      candidates: candidates.map((element, index) => ({ occurrence: index + 1, ...compactNode(element) }))
    };
  }

  function formalCitationCandidates(answerRoot) {
    if (!answerRoot) return [];
    return [...answerRoot.querySelectorAll('*')]
      .filter((element) => {
        const attrs = [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' ');
        const text = textOf(element);
        return /citation|reference|引用|来源|参考/i.test(attrs) && (/^\s*\[?\d+\]?\s*$/.test(text) || element.matches('a[href]'));
      })
      .map((element, index) => ({ occurrence: index + 1, ...nodeDescriptor(element) }));
  }

  function auxiliaryStatus(scope) {
    const matches = allElements(scope).filter((element) => {
      const text = textOf(element);
      const attrs = [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' ');
      return !isSidebarElement(element) && ((isVisible(element) && AUXILIARY_LABEL_RE.test(text)) || /(?:thinking|reasoning|processing|生成中|处理中)/i.test(attrs));
    });
    return matches.length ? 'observed' : 'not_observed';
  }

  const SENSITIVE_QUERY_KEY_RE = /(?:cookie|token|auth|authorization|signature|sig|secret|password|passwd|credential|session(?:id)?|access[-_]?key|api[-_]?key)/i;

  function isSensitiveQueryKey(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return SENSITIVE_QUERY_KEY_RE.test(String(key || '')) || normalized === 'abogus';
  }

  function finiteOrNull(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function sanitizeResourceUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl));
      const query = [];
      for (const [key, value] of parsed.searchParams.entries()) {
        query.push({ key, value: isSensitiveQueryKey(key) ? null : value });
      }
      const sanitized = new URL(parsed.origin + parsed.pathname);
      for (const parameter of query) sanitized.searchParams.append(parameter.key, parameter.value ?? '[REDACTED]');
      return {
        url: sanitized.toString(),
        origin: parsed.origin,
        path: parsed.pathname,
        query
      };
    } catch {
      return { url: null, origin: null, path: null, query: [] };
    }
  }

  function resourceCategory(initiatorType, url) {
    const type = String(initiatorType || '').toLowerCase();
    if (type === 'fetch') return 'fetch';
    if (type === 'xmlhttprequest') return 'xmlhttprequest';
    if (type === 'script') return 'script';
    if (type === 'link' || type === 'css') return 'css';
    if (type === 'img' || type === 'image') return 'image';
    if (type === 'websocket' || /^wss?:/i.test(String(url || ''))) return 'websocket-like';
    return 'other';
  }

  function resourceRelevance(path) {
    const tokens = String(path || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hasToken = (values) => values.some((value) => tokens.includes(value));
    if (hasToken(['reference', 'references', 'source', 'sources', 'citation', 'citations', 'cite'])) return 'reference/source';
    if (hasToken(['search', 'query', 'queries', 'keyword', 'keywords'])) return 'search';
    if (hasToken(['conversation', 'conversations', 'chat', 'message', 'messages', 'history'])) return 'conversation';
    return 'unknown';
  }

  function resourceDescriptor(entry, occurrence, source) {
    const safeUrl = sanitizeResourceUrl(entry?.name || entry?.url);
    const path = safeUrl.path;
    return {
      occurrence,
      order: occurrence,
      source,
      url: safeUrl.url,
      origin: safeUrl.origin,
      path,
      query: safeUrl.query,
      initiatorType: entry?.initiatorType || null,
      category: resourceCategory(entry?.initiatorType, safeUrl.url),
      candidate_relevance: resourceRelevance(path),
      candidate_relevance_basis: 'name/path heuristic',
      startTime: finiteOrNull(entry?.startTime),
      duration: finiteOrNull(entry?.duration),
      transferSize: finiteOrNull(entry?.transferSize),
      encodedBodySize: finiteOrNull(entry?.encodedBodySize),
      decodedBodySize: finiteOrNull(entry?.decodedBodySize),
      responseEnd: finiteOrNull(entry?.responseEnd)
    };
  }

  function domResourceDescriptors(documentRef) {
    return [...documentRef.querySelectorAll('script[src], link[href]')].map((element, index) => resourceDescriptor({
      name: element.src || element.href,
      initiatorType: element.tagName === 'SCRIPT' ? 'script' : 'link'
    }, index + 1, 'dom_descriptor'));
  }

  function loadedResourceInventory(documentRef = global.document) {
    let entries = [];
    try {
      entries = typeof global.performance?.getEntriesByType === 'function'
        ? global.performance.getEntriesByType('resource')
        : [];
    } catch {
      entries = [];
    }
    const source = entries.length ? 'performance_resource_timing' : 'dom_script_link_descriptors';
    const items = entries.length
      ? entries.map((entry, index) => resourceDescriptor(entry, index + 1, 'performance'))
      : domResourceDescriptors(documentRef);
    return {
      source,
      snapshot: 'stable_observation',
      item_count: items.length,
      items
    };
  }

  function currentConversationUrl(locationRef = global.location) {
    const href = locationRef?.href;
    if (typeof href !== 'string') return '';
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.hostname !== 'www.doubao.com') return '';
      if (!/^\/chat\/[^/]+$/.test(url.pathname)) return '';
      return href;
    } catch (_) {
      return '';
    }
  }

  function captureSnapshot(documentRef = global.document) {
    const summaryCandidate = findSummary(documentRef);
    const summaryElement = summaryCandidate?.element || null;
    const chatScope = findChatScope(documentRef, summaryElement);
    const inventory = summaryElement
      ? materializedInventory(probeScope(summaryElement), summaryCandidate.parsed.queryCount, summaryCandidate.parsed.referenceCount)
      : {
        queries_materialized: null,
        references_materialized: null,
        queries: null,
        references: null,
        list_inventory: []
      };
    const question = discoverQuestion(chatScope, summaryElement);
    const questionElements = question.candidates.map((candidate) => allElements(chatScope).find((element) => candidate.outerHTML === element.outerHTML)).filter(Boolean);
    const answerDiscovery = discoverAnswer(chatScope, summaryElement, questionElements);
    const answer = { ...answerDiscovery };
    delete answer.element;
    const currentSearchReferenceMapping = mapSearchReference(responseFacts, question, answer, documentRef);
    const result = {
      platform: 'doubao',
      conversation_url: currentConversationUrl(),
      question,
      answer,
      search_reference: {
        summary: summaryCandidate ? summaryCandidate.parsed.text : null,
        expected_query_count: summaryCandidate?.parsed.queryCount ?? null,
        expected_reference_count: summaryCandidate?.parsed.referenceCount ?? null,
        expanded_state: summaryElement ? expandedState(summaryElement) : 'unknown',
        root: summaryElement ? nodeDescriptor(summaryElement) : null,
        ...inventory
      },
      formal_citations: formalCitationCandidates(answerDiscovery.element),
      thinking_status: auxiliaryStatus(chatScope),
      processing_status: auxiliaryStatus(chatScope),
      loaded_resources: loadedResourceInventory(documentRef),
      response_observation: responseObservation,
      response_facts: responseFacts,
      current_search_reference_mapping: currentSearchReferenceMapping,
      observation_status: 'unstable'
    };
    return result;
  }

  function hasObservation(result) {
    return Boolean(
      result.question.candidates.length ||
      result.answer.text ||
      result.search_reference.summary
    );
  }

  function normalizedText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizedKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isConversationIdKey(key) {
    return ['conversationid', 'convid', 'conversationuuid', 'convuuid'].includes(normalizedKey(key));
  }

  function isMessageIdKey(key) {
    return ['messageid', 'msgid', 'messageuuid', 'msguuid'].includes(normalizedKey(key));
  }

  function collectObjects(value, predicate, path = '$', result = []) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectObjects(item, predicate, `${path}[${index}]`, result));
    } else if (value && typeof value === 'object') {
      if (predicate(value)) result.push({ value, path });
      Object.entries(value).forEach(([key, child]) => collectObjects(child, predicate, `${path}.${key}`, result));
    }
    return result;
  }

  function extractIdentity(object, keyPredicate) {
    let found = null;
    const visit = (value, seen = new Set()) => {
      if (found !== null || !value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) return value.forEach((item) => visit(item, seen));
      for (const [key, child] of Object.entries(value)) {
        if (keyPredicate(key) && (typeof child === 'string' || typeof child === 'number')) { found = String(child); return; }
        visit(child, seen);
        if (found !== null) return;
      }
    };
    visit(object);
    return found;
  }

  function extractPrimitiveIdentity(object, keyPredicate) {
    let found;
    const visit = (value, seen = new Set()) => {
      if (found !== undefined || !value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) return value.forEach((item) => visit(item, seen));
      for (const [key, child] of Object.entries(value)) {
        if (keyPredicate(key) && (child === null || ['string', 'number', 'boolean'].includes(typeof child))) { found = child; return; }
        visit(child, seen);
        if (found !== undefined) return;
      }
    };
    visit(object);
    return found === undefined ? null : found;
  }

  function currentConversationIdentity(documentRef = global.document) {
    const candidates = [];
    try {
      const url = new URL(global.location.href);
      const parts = url.pathname.split('/').filter(Boolean);
      for (let index = 0; index < parts.length - 1; index += 1) {
        if (/^(?:chat|conversation|conversations)$/i.test(parts[index]) && parts[index + 1]) {
          candidates.push({ id: parts[index + 1], source: 'route' });
        }
      }
    } catch {}
    const summary = findSummary(documentRef)?.element || null;
    const scope = findChatScope(documentRef, summary);
    for (const element of allElements(scope)) {
      const id = element.getAttribute?.('data-conversation-id');
      if (id && !isSidebarElement(element)) candidates.push({ id, source: 'main_dom_attribute' });
    }
    const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
    return {
      status: unique.length === 1 ? 'confirmed' : unique.length > 1 ? 'ambiguous' : 'unknown',
      conversation_id: unique.length === 1 ? unique[0].id : null,
      sources: unique.map((candidate) => candidate.source),
      corroborated: unique.length === 1 && new Set(candidates.map((candidate) => candidate.id)).size === 1
    };
  }

  function responseConversationObjects(fact) {
    return collectObjects(fact?.parsed_json, (object) => Object.entries(object).some(([key, value]) =>
      /conversationinfolist/i.test(normalizedKey(key)) && Array.isArray(value))).flatMap(({ value, path }) =>
      Object.entries(value).filter(([key, child]) => /conversationinfolist/i.test(normalizedKey(key)) && Array.isArray(child))
        .flatMap(([key, list]) => list.map((conversation, index) => ({ conversation, path: `${path}.${key}[${index}]` }))));
  }

  function messageRole(message) {
    let detected = null;
    const visit = (value) => {
      if (detected || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(visit);
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:role|sender|author|type)$/i.test(key) && typeof child === 'string') {
          const role = child.toLowerCase();
          if (/assistant|bot|ai|model/.test(role)) { detected = 'assistant'; return; }
          if (/user|human/.test(role)) { detected = 'user'; return; }
        }
        visit(child);
        if (detected) return;
      }
    };
    visit(message);
    return detected;
  }

  function messageText(message) {
    const values = [];
    const textKeys = /^(?:content|text|markdown|answer|message|content_text|output)$/i;
    const visit = (value, key = '', seen = new Set()) => {
      if (typeof value === 'string') {
        if (!textKeys.test(key)) return;
        const trimmed = value.trim();
        if (!trimmed) return;
        if (/^[\[{]/.test(trimmed)) {
          try {
            const parsed = JSON.parse(trimmed);
            visit(parsed, key, seen);
            return;
          } catch {}
        }
        values.push(value);
        return;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) value.forEach((item) => visit(item, key, seen));
      else Object.entries(value).forEach(([childKey, child]) => visit(child, childKey, seen));
    };
    visit(message);
    return normalizedText(values.join(' '));
  }

  function findSearchBlocks(message) {
    return collectObjects(message, (object) => Object.keys(object).some((key) => normalizedKey(key) === 'searchqueryresultblock'))
      .flatMap(({ value, path }) => Object.entries(value)
        .filter(([key]) => normalizedKey(key) === 'searchqueryresultblock')
        .map(([key, block]) => ({ block, path: `${path}.${key}` })));
  }

  function userTypeDiagnostics(messages, conversationId, question, answer) {
    const normalizedQuestion = normalizedText(question.text);
    const normalizedAnswer = normalizedText(answer.text);
    const summaries = messages.map((message, index) => {
      const text = messageText(message);
      const userType = extractPrimitiveIdentity(message, (key) => normalizedKey(key) === 'usertype');
      return {
        conversation_id: conversationId,
        message_id: extractIdentity(message, isMessageIdKey),
        sender_id: extractPrimitiveIdentity(message, (key) => normalizedKey(key) === 'senderid'),
        user_type: userType,
        order: index + 1,
        extracted_text_length: text.length,
        exact_page_question_match: Boolean(normalizedQuestion && text === normalizedQuestion),
        exact_page_answer_match: Boolean(normalizedAnswer && text === normalizedAnswer),
        has_search_query_result_block: findSearchBlocks(message).length > 0
      };
    });
    const questionMatches = summaries.filter((item) => item.exact_page_question_match);
    const answerMatches = summaries.filter((item) => item.exact_page_answer_match);
    const observedValues = [...new Set(summaries.map((item) => item.user_type).filter((value) => value !== null))];
    const uniqueQuestionTypes = [...new Set(questionMatches.map((item) => JSON.stringify(item.user_type)))];
    const uniqueAnswerTypes = [...new Set(answerMatches.map((item) => JSON.stringify(item.user_type)))];
    const fullyCorroborated = questionMatches.length === 1 && answerMatches.length === 1 &&
      questionMatches[0].user_type !== null && answerMatches[0].user_type !== null &&
      uniqueQuestionTypes.length === 1 && uniqueAnswerTypes.length === 1 &&
      uniqueQuestionTypes[0] !== uniqueAnswerTypes[0];
    return {
      status: fullyCorroborated ? 'fully_corroborated' : answerMatches.length === 1 || questionMatches.length === 1 ? 'partially_corroborated' : 'insufficient',
      question_exact_matches: questionMatches.map((item) => ({ message_id: item.message_id, user_type: item.user_type, sender_id: item.sender_id, order: item.order })),
      answer_exact_matches: answerMatches.map((item) => ({ message_id: item.message_id, user_type: item.user_type, sender_id: item.sender_id, order: item.order })),
      observed_user_type_values: observedValues,
      sender_ids_distinct: questionMatches.length === 1 && answerMatches.length === 1 && questionMatches[0].sender_id !== null && answerMatches[0].sender_id !== null && questionMatches[0].sender_id !== answerMatches[0].sender_id,
      messages: summaries
    };
  }

  function safeIdentityPrimitive(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  }

  function messageIdentityFields(message) {
    const roleLike = [];
    const typeLike = [];
    const roleKeys = /^(?:role|sender|author|direction|from|bot|assistant|user_type|sender_id)$/i;
    const typeKeys = /^(?:type|message_type|sender_type|content_type)$/i;
    const visit = (value, path = '$', seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`, seen));
      Object.entries(value).forEach(([key, child]) => {
        const primitive = safeIdentityPrimitive(child);
        const field = primitive === undefined ? null : { path: `${path}.${key}`, key, value_type: primitive === null ? 'null' : typeof primitive, primitive_value: primitive };
        if (field && roleKeys.test(key)) roleLike.push(field);
        if (field && typeKeys.test(key)) typeLike.push(field);
        visit(child, `${path}.${key}`, seen);
      });
    };
    visit(message);
    return { role_like_fields: roleLike, type_like_fields: typeLike };
  }

  function messageContentBlockCount(message) {
    let count = 0;
    const visit = (value, seen = new Set()) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) return value.forEach((item) => visit(item, seen));
      Object.entries(value).forEach(([key, child]) => {
        if (normalizedKey(key) === 'contentblock' && Array.isArray(child)) count += child.length;
        visit(child, seen);
      });
    };
    visit(message);
    return count;
  }

  function mappedItems(block) {
    const queries = [];
    const references = [];
    const queryContainerKey = /^(?:queries|query_list|search_queries|search_query_list)$/i;
    const queryTextKey = /^(?:query|keyword|search_query|search_query_text|text)$/i;
    const appendQuery = (value) => {
      if (typeof value === 'string') queries.push({ order: queries.length + 1, text: value });
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const text = Object.entries(value).find(([key, child]) => queryTextKey.test(key) && typeof child === 'string')?.[1];
        if (text !== undefined) queries.push({ order: queries.length + 1, text });
      }
    };
    const visit = (value, path = '$') => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== 'object') return;
      const keys = Object.keys(value).map(normalizedKey);
      const titleKey = Object.keys(value).find((key) => /^(?:title|name)$/i.test(key));
      const urlKey = Object.keys(value).find((key) => /^(?:url|href|link)$/i.test(key));
      if (titleKey || urlKey) references.push({ order: references.length + 1, ...value });
      Object.entries(value).forEach(([key, child]) => {
        if (queryContainerKey.test(key) && Array.isArray(child)) child.forEach(appendQuery);
        else if (queryTextKey.test(key) && typeof child === 'string') appendQuery(child);
        else visit(child, `${path}.${key}`);
      });
    };
    visit(block);
    return { queries, references };
  }

  function mapSearchReference(responseFacts, question, answer, documentRef = global.document) {
    const pageIdentity = currentConversationIdentity(documentRef);
    const facts = (Array.isArray(responseFacts) ? responseFacts : []).filter((fact) => fact.path === '/im/conversation/batch_get');
    const conversations = facts.flatMap(responseConversationObjects);
    const matches = pageIdentity.conversation_id
      ? conversations.filter(({ conversation }) => extractIdentity(conversation, isConversationIdKey) === pageIdentity.conversation_id)
      : [];
    const conversationMapping = {
      status: pageIdentity.status === 'ambiguous' ? 'ambiguous' : matches.length === 1 ? 'confirmed' : 'unknown',
      page_conversation_id: pageIdentity.conversation_id,
      response_conversation_id: matches.length === 1 ? extractIdentity(matches[0].conversation, isConversationIdKey) : null,
      response_conversation_occurrence: matches.length === 1 ? matches[0].path : null,
      match_basis: matches.length === 1 ? 'exact_conversation_id' : null
    };
    if (conversationMapping.status !== 'confirmed') return {
      status: conversationMapping.status,
      conversation_mapping: conversationMapping,
      message_mapping: { status: 'unknown', diagnostics: { response_message_count: 0, assistant_candidate_count: 0, exact_text_match_count: 0, selected_message_order: null, messages: [], candidates: [], failure_reason: 'other' } },
      block_mapping: { status: 'unknown', count: 0, occurrence: null, message_occurrence: null }, user_type_diagnostics: null, queries: null, references: null
    };
    const messages = Array.isArray(matches[0].conversation.messages) ? matches[0].conversation.messages : [];
    const identityDiagnostics = userTypeDiagnostics(messages, conversationMapping.response_conversation_id, question, answer);
    const assistantCandidates = messages.map((message, index) => ({ message, index, role: messageRole(message), text: messageText(message) }))
      .filter(({ role }) => role === 'assistant');
    const normalizedAnswer = normalizedText(answer.text);
    const assistantMatches = assistantCandidates.filter(({ text }) => normalizedAnswer && text === normalizedAnswer);
    const allBlocks = messages.flatMap((message, messageIndex) => findSearchBlocks(message)
      .map((block) => ({ ...block, message_occurrence: messageIndex + 1 })));
    const blockMapping = {
      status: allBlocks.length === 1 ? 'confirmed' : allBlocks.length > 1 ? 'ambiguous' : 'not_observed',
      count: allBlocks.length,
      occurrence: allBlocks.length === 1 ? allBlocks[0].path : null,
      message_occurrence: allBlocks.length === 1 ? allBlocks[0].message_occurrence : null
    };
    const items = allBlocks.length === 1 ? mappedItems(allBlocks[0].block) : { queries: null, references: null };
    const messageDiagnostics = {
      response_message_count: messages.length,
      assistant_candidate_count: assistantCandidates.length,
      exact_text_match_count: assistantMatches.length,
      selected_message_order: assistantMatches.length === 1 ? assistantMatches[0].index + 1 : null,
      messages: messages.map((message, index) => {
        const identityFields = messageIdentityFields(message);
        return {
          occurrence: index + 1,
          message_id: extractIdentity(message, isMessageIdKey),
          top_level_keys: Object.keys(message),
          ...identityFields,
          content_block_count: messageContentBlockCount(message),
          has_search_query_result_block: findSearchBlocks(message).length > 0,
          extracted_text_length: messageText(message).length
        };
      }),
      candidates: assistantCandidates.map(({ message, index, role, text }) => ({
        occurrence: index + 1,
        message_id: extractIdentity(message, isMessageIdKey),
        detected_role: role,
        extracted_text_length: text.length,
        content_block_count: Array.isArray(message.content_block) ? message.content_block.length : 0,
        has_search_query_result_block: findSearchBlocks(message).length > 0,
        exact_page_answer_match: Boolean(normalizedAnswer && text === normalizedAnswer)
      })),
      failure_reason: null
    };
    if (!assistantCandidates.length) messageDiagnostics.failure_reason = 'no_assistant_candidate';
    else if (!assistantCandidates.some(({ text }) => text.length)) messageDiagnostics.failure_reason = 'response_text_unavailable';
    else if (!assistantMatches.length) messageDiagnostics.failure_reason = 'no_text_match';
    else if (assistantMatches.length > 1) messageDiagnostics.failure_reason = 'multiple_text_matches';
    const messageMapping = {
      status: assistantMatches.length === 1 ? 'confirmed' : assistantMatches.length > 1 ? 'ambiguous' : 'unknown',
      response_message_id: assistantMatches.length === 1 ? extractIdentity(assistantMatches[0].message, isMessageIdKey) : null,
      response_message_occurrence: assistantMatches.length === 1 ? assistantMatches[0].index + 1 : null,
      match_basis: assistantMatches.length === 1 ? 'role_and_exact_normalized_answer_text' : null,
      diagnostics: messageDiagnostics,
      user_type_diagnostics: identityDiagnostics
    };
    return { status: blockMapping.status, conversation_mapping: conversationMapping, message_mapping: messageMapping, block_mapping: blockMapping, user_type_diagnostics: identityDiagnostics, queries: blockMapping.status === 'confirmed' ? items.queries : null, references: blockMapping.status === 'confirmed' ? items.references : null };
  }

  function fingerprint(result) {
    return JSON.stringify({
      conversation_url: result.conversation_url,
      question: result.question.status === 'confirmed'
        ? [result.question.text, result.question.occurrence]
        : null,
      answer: [result.answer.status, result.answer.text, result.answer.occurrence],
      search_reference: {
        summary: result.search_reference.summary,
        expected_query_count: result.search_reference.expected_query_count,
        expected_reference_count: result.search_reference.expected_reference_count,
        queries_materialized: result.search_reference.queries_materialized,
        references_materialized: result.search_reference.references_materialized,
        queries: result.search_reference.queries?.map((item) => [item.order, item.text]),
        references: result.search_reference.references?.map((item) => [item.order, item.text, item.href_probe.direct_url])
      },
      formal_citations: result.formal_citations.map((citation) => [
        citation.occurrence,
        citation.text,
        citation.attributes?.href || citation.attributes?.url || null
      ]),
      thinking_status: result.thinking_status,
      processing_status: result.processing_status,
      current_search_reference_mapping: result.current_search_reference_mapping.status === 'confirmed'
        ? {
          queries: result.current_search_reference_mapping.queries?.map((item) => [item.order, item.text]),
          references: result.current_search_reference_mapping.references?.map((item) => [item.order, item.title || item.name || null, item.url || item.href || item.link || null])
        }
        : result.current_search_reference_mapping.status
    });
  }

  let debounceTimer = null;
  let stabilityTimer = null;
  let lastEmittedSemanticFingerprint = null;
  let publishedObservationCount = 0;
  let lastPublishedAt = null;
  let responseFacts = [];
  let responseObservation = {
    status: 'unavailable',
    probe_started_at: null,
    snapshot_at: null,
    candidate_occurrence_count: 0
  };

  function acceptsResponseProbePayload(payload) {
    return Boolean(payload &&
      (payload.status === 'active' || payload.status === 'unavailable') &&
      Array.isArray(payload.facts) &&
      typeof payload.candidate_occurrence_count === 'number' &&
      payload.facts.every((fact) => fact &&
        Number.isInteger(fact.occurrence) &&
        ['fetch', 'xhr'].includes(fact.transport) &&
        typeof fact.body_status === 'string' &&
        typeof fact.body_kind === 'string'));
  }

  function requestResponseProbeSnapshot() {
    global.postMessage({
      namespace: RESPONSE_PROBE_NAMESPACE,
      type: RESPONSE_PROBE_REQUEST
    }, '*');
  }

  function updateRuntimeStatus() {
    const current = global.__AI_GEO_DOUBAO_SPIKE_RUNTIME_STATUS__ || {};
    const responsePrivacyAudit = auditResponsePrivacy(responseFacts);
    const latest = global.__AI_GEO_DOUBAO_SPIKE_LAST_RESULT__;
    const mapping = latest?.question && latest?.answer
      ? mapSearchReference(responseFacts, latest.question, latest.answer)
      : null;
    global.__AI_GEO_DOUBAO_SPIKE_RUNTIME_STATUS__ = {
      ...current,
      probe_status: responseObservation.status,
      response_fact_count: responseFacts.length,
      candidate_occurrence_count: responseObservation.candidate_occurrence_count,
      latest_response_timestamp: responseObservation.snapshot_at,
      response_privacy_audit: responsePrivacyAudit,
      current_mapping_status: mapping?.status || 'unknown',
      mapped_conversation: mapping?.conversation_mapping?.response_conversation_id || null,
      mapped_message: mapping?.message_mapping?.response_message_id || null,
      mapped_search_block_count: mapping?.block_mapping?.count ?? null,
      mapped_query_count: mapping?.queries?.length ?? null,
      mapped_reference_count: mapping?.references?.length ?? null,
      mapped_nonempty_url_count: mapping?.references
        ? mapping.references.filter((item) => Boolean(item.url || item.href || item.link)).length
        : null,
      message_mapping_diagnostics: mapping?.message_mapping?.diagnostics || {
        response_message_count: 0,
        assistant_candidate_count: 0,
        exact_text_match_count: 0,
        selected_message_order: null,
        messages: [],
        candidates: [],
        failure_reason: 'other'
      },
      user_type_diagnostics: mapping?.user_type_diagnostics || null
    };
    if (latest) {
      latest.response_observation = responseObservation;
      latest.response_facts = responseFacts;
      latest.current_search_reference_mapping = mapping || latest.current_search_reference_mapping;
    }
  }

  function isSensitiveAuditKey(key) {
    const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return /(?:token|auth|signature|secret|password|passwd|credential|session|cookie|csrf|xsrf|accesskey|apikey|sign)/i.test(normalized) || normalized === 'abogus';
  }

  function isRedactedValue(value) {
    return value === null || value === '[REDACTED]';
  }

  function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function addUnredactedFinding(audit, path, key, detectionType, value) {
    const findingKey = `${path}|${key}|${detectionType}`;
    if (audit.finding_keys.has(findingKey)) return;
    audit.finding_keys.add(findingKey);
    audit.unredacted_findings.push({
      path,
      key: String(key || ''),
      detection_type: detectionType,
      value_type: valueType(value)
    });
    audit.unredacted_by_key[key] = (audit.unredacted_by_key[key] || 0) + 1;
    audit.unredacted_by_detection_type[detectionType] =
      (audit.unredacted_by_detection_type[detectionType] || 0) + 1;
  }

  function inspectResponseValue(value, path, key, audit, detectionType = 'other') {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectResponseValue(item, `${path}[${index}]`, String(index), audit));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([childKey, child]) => {
        inspectResponseValue(child, `${path}.${childKey}`, childKey, audit);
      });
      return;
    }
    if (typeof value !== 'string') {
      if (isSensitiveAuditKey(key) && !isRedactedValue(value)) {
        addUnredactedFinding(audit, path, key, 'object_key', value);
      }
      return;
    }
    const urlMatches = value.match(/(?:https?:\/\/|\/\/)[^\s"'<>]+/gi) || [];
    for (const rawUrl of urlMatches) {
      audit.url_string_count += 1;
      try {
        const parsed = new URL(rawUrl.replace(/[),.;!?]+$/g, ''), 'https://www.doubao.com');
        const sourceKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (/(?:url|href|link|source|reference)/.test(sourceKey)) {
          audit.source_url_count += 1;
          if (parsed.pathname) audit.nonempty_source_url_count += 1;
        }
        for (const [queryKey, queryValue] of parsed.searchParams.entries()) {
          if (isSensitiveAuditKey(queryKey)) {
            audit.sensitive_query_key_count += 1;
          if (!isRedactedValue(queryValue)) {
            addUnredactedFinding(
              audit,
              `${path}?${queryKey}`,
              queryKey,
              detectionType === 'raw_text_url' ? 'raw_text_url' : 'url_query',
              queryValue
            );
          }
          }
        }
      } catch {}
    }
    if (isSensitiveAuditKey(key) && !isRedactedValue(value)) {
      addUnredactedFinding(audit, path, key, detectionType === 'other' ? 'object_key' : detectionType, value);
    }
  }

  function auditResponsePrivacy(facts) {
    const audit = {
      status: 'pass',
      response_fact_count_scanned: Array.isArray(facts) ? facts.length : 0,
      url_string_count: 0,
      sensitive_query_key_count: 0,
      unredacted_sensitive_value_count: 0,
      redaction_record_count: 0,
      source_url_count: 0,
      nonempty_source_url_count: 0,
      audit_timestamp: new Date().toISOString(),
      unredacted_findings: [],
      unredacted_by_key: {},
      unredacted_by_detection_type: {},
      finding_keys: new Set()
    };
    for (const fact of Array.isArray(facts) ? facts : []) {
      audit.redaction_record_count += Array.isArray(fact.redactions) ? fact.redactions.length : 0;
      inspectResponseValue(fact.parsed_json, '$.parsed_json', 'parsed_json', audit);
      inspectResponseValue(fact.raw_text, '$.raw_text', 'raw_text', audit, 'raw_text_url');
    }
    delete audit.finding_keys;
    audit.unredacted_sensitive_value_count = audit.unredacted_findings.length;
    audit.status = audit.unredacted_sensitive_value_count === 0 ? 'pass' : 'fail';
    return audit;
  }

  global.addEventListener('message', (event) => {
    if (event.source !== global || event.data?.namespace !== RESPONSE_PROBE_NAMESPACE || event.data?.type !== RESPONSE_PROBE_RESPONSE) return;
    if (!acceptsResponseProbePayload(event.data.payload)) return;
    responseFacts = event.data.payload.facts;
    responseObservation = {
      status: event.data.payload.status,
      probe_started_at: event.data.payload.probe_started_at || null,
      snapshot_at: event.data.payload.snapshot_at || null,
      candidate_occurrence_count: event.data.payload.candidate_occurrence_count
    };
    updateRuntimeStatus();
  });

  function emitStable(snapshot, snapshotFingerprint) {
    const latest = captureSnapshot();
    const latestSemanticFingerprint = fingerprint(latest);
    if (latestSemanticFingerprint !== snapshotFingerprint) {
      scheduleCapture();
      return;
    }
    latest.observation_status = 'stable';
    if (!hasObservation(latest) || latestSemanticFingerprint === lastEmittedSemanticFingerprint) return;
    lastEmittedSemanticFingerprint = latestSemanticFingerprint;
    global.__AI_GEO_DOUBAO_SPIKE_LAST_RESULT__ = latest;
    publishObservation(latest, latestSemanticFingerprint);
  }

  function publishObservation(observation, semanticFingerprint) {
    publishedObservationCount += 1;
    lastPublishedAt = new Date().toISOString();
    global.__AI_GEO_DOUBAO_SPIKE_RUNTIME_STATUS__ = {
      status: 'stable',
      probe_status: responseObservation.status,
      response_fact_count: responseFacts.length,
      candidate_occurrence_count: responseObservation.candidate_occurrence_count,
      last_observation_timestamp: lastPublishedAt,
      latest_response_timestamp: responseObservation.snapshot_at,
      publish_count: publishedObservationCount,
      semantic_fingerprint: semanticFingerprint,
      response_privacy_audit: auditResponsePrivacy(responseFacts),
      current_mapping_status: observation.current_search_reference_mapping.status,
      mapped_conversation: observation.current_search_reference_mapping.conversation_mapping?.response_conversation_id || null,
      mapped_message: observation.current_search_reference_mapping.message_mapping?.response_message_id || null,
      mapped_search_block_count: observation.current_search_reference_mapping.block_mapping?.count ?? null,
      mapped_query_count: observation.current_search_reference_mapping.queries?.length ?? null,
      mapped_reference_count: observation.current_search_reference_mapping.references?.length ?? null,
      mapped_nonempty_url_count: observation.current_search_reference_mapping.references
        ? observation.current_search_reference_mapping.references.filter((item) => Boolean(item.url || item.href || item.link)).length
        : null,
      message_mapping_diagnostics: observation.current_search_reference_mapping.message_mapping?.diagnostics || {
        response_message_count: 0,
        assistant_candidate_count: 0,
        exact_text_match_count: 0,
        selected_message_order: null,
        messages: [],
        candidates: [],
        failure_reason: 'other'
      },
      user_type_diagnostics: observation.current_search_reference_mapping.user_type_diagnostics || null
    };
    const unifiedRuntime = global.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__;
    if (unifiedRuntime) {
      const unifiedSession = unifiedRuntime.activatePlatform('doubao');
      unifiedSession?.publishObservation(observation, semanticFingerprint);
    }
    console.info(
      '[AI-GEO Doubao] observation stable',
      `question=${observation.question.status}`,
      `answer=${observation.answer.status}`,
      `responses=${responseFacts.length}`
    );
  }

  function scheduleCapture() {
    if (debounceTimer !== null) global.clearTimeout(debounceTimer);
    if (stabilityTimer !== null) global.clearTimeout(stabilityTimer);
    debounceTimer = global.setTimeout(() => {
      debounceTimer = null;
      const snapshot = captureSnapshot();
      const snapshotFingerprint = fingerprint(snapshot);
      global.__AI_GEO_DOUBAO_SPIKE_LAST_RESULT__ = snapshot;
      stabilityTimer = global.setTimeout(() => {
        stabilityTimer = null;
        emitStable(snapshot, snapshotFingerprint);
      }, RESULT_STABLE_MS);
    }, MUTATION_DEBOUNCE_MS);
  }

  global.__AI_GEO_DOUBAO_SPIKE__ = Object.freeze({ capture: captureSnapshot });
  global.__AI_GEO_DOUBAO_SPIKE_LAST_RESULT__ = captureSnapshot();
  global.__AI_GEO_DOUBAO_SPIKE_RUNTIME_STATUS__ = {
    status: 'starting',
    probe_status: responseObservation.status,
    response_fact_count: 0,
    candidate_occurrence_count: 0,
    last_observation_timestamp: null,
    latest_response_timestamp: null,
    publish_count: 0,
    semantic_fingerprint: null,
    response_privacy_audit: auditResponsePrivacy([]),
    current_mapping_status: 'unknown',
    mapped_conversation: null,
    mapped_message: null,
    mapped_search_block_count: null,
    mapped_query_count: null,
    mapped_reference_count: null,
    mapped_nonempty_url_count: null,
    message_mapping_diagnostics: {
      response_message_count: 0,
      assistant_candidate_count: 0,
      exact_text_match_count: 0,
      selected_message_order: null,
      messages: [],
      candidates: [],
      failure_reason: 'other'
    },
    user_type_diagnostics: null
  };
  requestResponseProbeSnapshot();
  scheduleCapture();

  const observer = new MutationObserver(() => scheduleCapture());
  if (global.document.documentElement) {
    observer.observe(global.document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }
})(globalThis);
