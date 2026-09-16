(function installDeepSeekReadOnlySpike(global) {
  'use strict';

  const RESPONSE_ROOT_SELECTOR = '.ds-message:has(.ds-assistant-message-main-content)';
  const FINAL_ANSWER_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
  const CITATION_SELECTOR = `${FINAL_ANSWER_SELECTOR} .ds-markdown-cite`;
  const SOURCE_LABEL_RE = /^(?:(?:已阅读|已搜索|搜索结果)\s*)?\d+\s*个网页$/;
  const MUTATION_DEBOUNCE_MS = 200;
  const RESULT_STABLE_MS = 1_000;

  function isVisible(element) {
    if (!element || typeof element.getClientRects !== 'function') return false;
    const style = global.getComputedStyle(element);
    return Boolean(
      element.getClientRects().length &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  }

  function visibleLast(elements) {
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      if (isVisible(elements[index])) return elements[index];
    }
    return null;
  }

  function sourceCount(responseRoot) {
    const labels = [...responseRoot.querySelectorAll('*')]
      .filter(isVisible)
      .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => SOURCE_LABEL_RE.test(text));
    if (!labels.length) return null;
    const match = labels[labels.length - 1].match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function citationUrl(citation) {
    const anchor = citation.closest('a[href]');
    if (!anchor) return null;
    const rawHref = String(anchor.getAttribute('href') || '').trim();
    if (!rawHref) return null;
    try {
      const resolved = new URL(rawHref, global.location.href);
      return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
    } catch (_error) {
      return null;
    }
  }

  function virtualTurnKey(message) {
    const raw = message?.parentElement?.getAttribute('data-virtual-list-item-key');
    if (!/^-?\d+$/.test(String(raw || ''))) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value !== 0 ? value : null;
  }

  function questionText(message) {
    const copy = message?.cloneNode(true);
    if (!copy) return '';
    copy.querySelectorAll('button, [role="button"]').forEach((element) => element.remove());
    return String(copy.innerText || copy.textContent || '').trim();
  }

  function isAssistantMessage(message) {
    return Boolean(message?.querySelector(FINAL_ANSWER_SELECTOR));
  }

  function strongPairedQuestion(responseRoot, messages) {
    const assistantKey = virtualTurnKey(responseRoot);
    if (!assistantKey || assistantKey < 0) return '';
    const responseIndex = messages.indexOf(responseRoot);
    if (responseIndex < 1) return '';
    const candidates = messages
      .slice(0, responseIndex)
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => !isAssistantMessage(message))
      .filter(({ message }) => virtualTurnKey(message) === -assistantKey);
    if (candidates.length !== 1 || candidates[0].index !== responseIndex - 1) return '';
    return questionText(candidates[0].message);
  }

  function singleTurnQuestion(responseRoot, messages) {
    const responseIndex = messages.indexOf(responseRoot);
    const assistants = messages.filter(isAssistantMessage);
    const candidates = messages.filter((message) => !isAssistantMessage(message));
    if (responseIndex < 0 || assistants.length !== 1 || assistants[0] !== responseRoot || candidates.length !== 1) return '';
    if (messages.indexOf(candidates[0]) >= responseIndex) return '';
    return questionText(candidates[0]);
  }

  function pairedQuestion(responseRoot, documentRef = global.document) {
    const messages = [...documentRef.querySelectorAll('.ds-message')];
    const strongQuestion = strongPairedQuestion(responseRoot, messages);
    return strongQuestion || singleTurnQuestion(responseRoot, messages);
  }

  function currentConversationUrl(locationRef = global.location) {
    const href = locationRef?.href;
    if (typeof href !== 'string') return '';
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:' || url.hostname !== 'chat.deepseek.com') return '';
      if (!/^\/a\/chat\/s\/[^/]+$/.test(url.pathname)) return '';
      return href;
    } catch (_error) {
      return '';
    }
  }

  function locateResponse(documentRef = global.document) {
    const responseRoots = [...documentRef.querySelectorAll(RESPONSE_ROOT_SELECTOR)];
    const responseRoot = visibleLast(responseRoots);
    if (!responseRoot) return { responseRoot: null, responseIdentity: null };
    const responseIndex = responseRoots.indexOf(responseRoot);
    const responseIdentity = [
      responseRoot.getAttribute('data-message-id'),
      responseRoot.getAttribute('data-id'),
      responseRoot.id
    ].find(Boolean) || `dom-index:${responseIndex}`;
    return { responseRoot, responseIdentity };
  }

  function captureSnapshot(documentRef = global.document) {
    const { responseRoot, responseIdentity } = locateResponse(documentRef);
    const conversation_url = currentConversationUrl();
    if (!responseRoot) {
      return {
        responseIdentity: null,
        result: {
          conversation_url,
          question: '',
          answer: '',
          answer_html: '',
          citation_occurrences: [],
          unique_citation_urls: [],
          platform_reported_source_count: null
        }
      };
    }

    const finalAnswer = visibleLast([...responseRoot.querySelectorAll(FINAL_ANSWER_SELECTOR)]);
    if (!finalAnswer) {
      return {
        responseIdentity,
        result: {
          conversation_url,
          question: pairedQuestion(responseRoot, documentRef),
          answer: '',
          answer_html: '',
          citation_occurrences: [],
          unique_citation_urls: [],
          platform_reported_source_count: sourceCount(responseRoot)
        }
      };
    }

    const citation_occurrences = [...finalAnswer.querySelectorAll(CITATION_SELECTOR)]
      .map((citation, index) => ({ position: index + 1, url: citationUrl(citation) }));
    const unique_citation_urls = [...new Set(
      citation_occurrences.map((citation) => citation.url).filter(Boolean)
    )];

    return {
      responseIdentity,
      result: {
        conversation_url,
        question: pairedQuestion(responseRoot, documentRef),
        answer: String(finalAnswer.innerText || finalAnswer.textContent || '').trim(),
        answer_html: finalAnswer.innerHTML,
        citation_occurrences,
        unique_citation_urls,
        platform_reported_source_count: sourceCount(responseRoot)
      }
    };
  }

  function capture(documentRef = global.document) {
    return captureSnapshot(documentRef).result;
  }

  function fingerprint(snapshot) {
    return JSON.stringify({
      response_identity: snapshot.responseIdentity,
      conversation_url: snapshot.result.conversation_url,
      question: snapshot.result.question,
      answer: snapshot.result.answer,
      answer_html: snapshot.result.answer_html,
      citation_occurrences: snapshot.result.citation_occurrences,
      platform_reported_source_count: snapshot.result.platform_reported_source_count
    });
  }

  let debounceTimer = null;
  let stabilityTimer = null;
  let lastEmittedFingerprint = '';

  function emitStable(snapshot, snapshotFingerprint) {
    const latest = captureSnapshot();
    const latestFingerprint = fingerprint(latest);
    if (latestFingerprint !== snapshotFingerprint) {
      scheduleCapture();
      return;
    }
    global.__AI_GEO_DEEPSEEK_SPIKE_LAST_RESULT__ = latest.result;
    if (!latest.result.answer || latestFingerprint === lastEmittedFingerprint) return;
    lastEmittedFingerprint = latestFingerprint;
    const unifiedRuntime = global.__AI_GEO_UNIFIED_EXTENSION_RUNTIME__;
    if (unifiedRuntime) {
      const unifiedSession = unifiedRuntime.activatePlatform('deepseek');
      unifiedSession?.publishObservation(latest.result, latestFingerprint);
    }
    console.info('[AI-GEO DeepSeek read-only spike]', JSON.stringify(latest.result));
  }

  function scheduleCapture() {
    if (debounceTimer !== null) global.clearTimeout(debounceTimer);
    if (stabilityTimer !== null) global.clearTimeout(stabilityTimer);
    debounceTimer = global.setTimeout(() => {
      debounceTimer = null;
      const snapshot = captureSnapshot();
      const snapshotFingerprint = fingerprint(snapshot);
      global.__AI_GEO_DEEPSEEK_SPIKE_LAST_RESULT__ = snapshot.result;
      stabilityTimer = global.setTimeout(() => {
        stabilityTimer = null;
        emitStable(snapshot, snapshotFingerprint);
      }, RESULT_STABLE_MS);
    }, MUTATION_DEBOUNCE_MS);
  }

  global.__AI_GEO_DEEPSEEK_SPIKE__ = Object.freeze({ capture });
  global.__AI_GEO_DEEPSEEK_SPIKE_LAST_RESULT__ = capture();
  scheduleCapture();

  const observer = new MutationObserver(() => scheduleCapture());
  if (global.document.documentElement) {
    observer.observe(global.document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
})(globalThis);
