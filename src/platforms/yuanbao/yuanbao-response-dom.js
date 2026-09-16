import { fingerprint } from '../../core/hash.js';

export const YUANBAO_COMPLETED_RESPONSE_SELECTOR = '[data-conv-speaker="ai"][data-conv-outputting="false"]';
export const YUANBAO_FINAL_ANSWER_SELECTOR = '.hyc-content-md-done';
export const YUANBAO_CITATION_TRIGGER_SELECTOR = '.hyc-common-markdown__ref-list__trigger';
export const YUANBAO_SOURCE_POOL_SELECTOR = '#search-guide-tool[data-toolbar-type="citation"]';

const POPUP_SELECTOR = '.hyc-common-markdown__ref-list__popup';
const CARD_SELECTOR = '.hyc-common-markdown__ref_card[data-url]';
const NEXT_CARD_SELECTOR = '.hyc-common-markdown__ref-list__header button:has(.icon-arrow-right):not([disabled])';
const POPUP_RESET_TIMEOUT_MS = 2_000;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function parseIndexList(value) {
  return String(value || '').split(/[\s,]+/).filter(Boolean);
}

function createTriggerDiagnostic(triggerPosition, dataIdxList) {
  return {
    trigger_position: triggerPosition,
    data_idx_list: dataIdxList,
    trigger_visible: false,
    hover_started: false,
    popup_found: false,
    popup_visible: false,
    expected_idx: dataIdxList[0] ?? null,
    current_idx: null,
    card_found: false,
    data_url_present: false,
    next_arrow_found: null,
    next_arrow_click: false,
    dom_remounted: null,
    popup_reacquired: false,
    card_reacquired: false,
    new_idx: null,
    popup_reset_started: false,
    popup_reset_completed: false,
    popup_reset_elapsed_ms: null,
    popup_reset_visible_count: null,
    failure_stage: null,
    failure_reason: null,
    carousel_steps: [],
    parsed_citations: []
  };
}

function markFailure(diagnostic, stage, reason) {
  if (!diagnostic.failure_stage) diagnostic.failure_stage = stage;
  if (!diagnostic.failure_reason) diagnostic.failure_reason = reason;
}

function applyStepToTrigger(diagnostic, step) {
  diagnostic.expected_idx = step.expected_idx;
  diagnostic.current_idx = step.current_idx;
  diagnostic.card_found = step.card_found;
  diagnostic.data_url_present = step.data_url_present;
  diagnostic.next_arrow_found = step.next_arrow_found;
  diagnostic.next_arrow_click = step.next_arrow_click;
  diagnostic.dom_remounted = step.dom_remounted;
  diagnostic.popup_reacquired = step.popup_reacquired;
  diagnostic.card_reacquired = step.card_reacquired;
  diagnostic.new_idx = step.new_idx;
  diagnostic.failure_stage = step.failure_stage;
  diagnostic.failure_reason = step.failure_reason;
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

/**
 * Yuanbao response DOM extraction. It deliberately has no login, fresh-chat,
 * or Prompt-submission API; those lifecycle operations remain in the Adapter.
 */
export class YuanbaoResponseDom {
  constructor(page) {
    this.page = page;
  }

  async locateCompletedResponse(baselineCount = 0) {
    const roots = this.page.locator(YUANBAO_COMPLETED_RESPONSE_SELECTOR);
    const count = await roots.count();
    if (count <= baselineCount) return null;
    const root = roots.nth(count - 1);
    return await this.isCompleted(root) ? root : null;
  }

  async isCompleted(responseRoot) {
    if (await responseRoot.getAttribute('data-conv-outputting') !== 'false') return false;
    const finalAnswer = responseRoot.locator(YUANBAO_FINAL_ANSWER_SELECTOR).last();
    return await isVisible(finalAnswer) && cleanText(await finalAnswer.innerText()).length > 0;
  }

  async extractAnswer(responseRoot) {
    const finalAnswer = responseRoot.locator(YUANBAO_FINAL_ANSWER_SELECTOR).last();
    if (!(await isVisible(finalAnswer))) throw new Error('Yuanbao completed response has no visible final Markdown.');
    const text = cleanText(await finalAnswer.innerText());
    if (!text) throw new Error('Yuanbao completed response has no final-answer text.');
    return { text, fingerprint: fingerprint(text), evidenceRoot: finalAnswer };
  }

  async observeSourcePool(responseRoot) {
    const label = await responseRoot.locator(YUANBAO_SOURCE_POOL_SELECTOR).first().getAttribute('aria-label').catch(() => null);
    const count = label?.match(/(\d+)\s*篇/)?.[1];
    return { platform_reported_source_count: count ? Number(count) : null };
  }

  async extractCitations(responseRoot) {
    const triggers = responseRoot.locator(YUANBAO_CITATION_TRIGGER_SELECTOR);
    const citations = [];
    let panel = null;
    const diagnostics = {
      scope: 'accepted_response',
      trigger_count: await triggers.count(),
      triggers: [],
      first_failure: null,
      parsed_citations: []
    };
    for (let triggerIndex = 0; triggerIndex < diagnostics.trigger_count; triggerIndex += 1) {
      const trigger = triggers.nth(triggerIndex);
      const sourceIndexes = parseIndexList(await trigger.getAttribute('data-idx-list'));
      const diagnostic = createTriggerDiagnostic(triggerIndex + 1, sourceIndexes);
      diagnostics.triggers.push(diagnostic);
      if (triggerIndex > 0) {
        const reset = await this.#resetCitationPopup(responseRoot);
        diagnostic.popup_reset_started = true;
        diagnostic.popup_reset_completed = reset.cleared;
        diagnostic.popup_reset_elapsed_ms = reset.elapsed_ms;
        diagnostic.popup_reset_visible_count = reset.visible_count;
        if (!reset.cleared) {
          markFailure(diagnostic, reset.failure_stage, reset.failure_reason);
          return this.#parseFailure(diagnostics, diagnostic, 'popup_reset_timeout');
        }
      }
      diagnostic.trigger_visible = await isVisible(trigger);
      if (!diagnostic.trigger_visible) {
        markFailure(diagnostic, 'trigger_visibility', 'trigger_not_visible');
        return this.#parseFailure(diagnostics, diagnostic, 'trigger_not_visible');
      }
      if (sourceIndexes.length === 0) {
        markFailure(diagnostic, 'index_list', 'missing_source_indexes');
        return this.#parseFailure(diagnostics, diagnostic, 'missing_source_indexes');
      }
      const popupResult = await this.#openPopupForTrigger(trigger, sourceIndexes, diagnostic);
      if (!popupResult.popup) {
        markFailure(diagnostic, 'popup_bind', diagnostic.popup_found ? 'new_popup_card_not_bound_to_trigger' : 'no_new_popup_after_hover');
        return this.#parseFailure(diagnostics, diagnostic, 'popup_not_bound_to_trigger');
      }
      const carouselResult = await this.#readCarousel(popupResult.popup, sourceIndexes, diagnostic);
      if (carouselResult.failure) {
        return this.#parseFailure(diagnostics, diagnostic, 'carousel_card_mismatch');
      }
      const cards = carouselResult.cards;
      if (cards.length !== sourceIndexes.length || cards.some((card) => !sourceIndexes.includes(card.dataIdx))) {
        markFailure(diagnostic, 'carousel_validation', 'card_index_or_length_mismatch');
        return this.#parseFailure(diagnostics, diagnostic, 'carousel_card_mismatch');
      }
      panel = popupResult.popup;
      for (const [sourcePosition, card] of cards.entries()) {
        citations.push({
          // Position denotes the inline trigger occurrence, not a URL rank.
          // A multi-source trigger therefore yields several records with the
          // same position; duplicate URLs are intentionally preserved.
          position: triggerIndex + 1,
          trigger_position: triggerIndex + 1,
          source_position: sourcePosition + 1,
          source_index: card.dataIdx,
          title: card.title,
          link_url: card.dataUrl,
          // The card exposes a visible source label, not a domain. Do not
          // derive a domain from its URL.
          display_domain: null,
          source_site: card.sourceSite,
          association_method: 'trigger_bound'
        });
      }
      diagnostic.parsed_citations = citations.slice(-cards.length);
      diagnostics.parsed_citations = citations.slice();
    }
    return citations.length > 0
      ? { status: 'captured', citations, panel, diagnostics }
      : { status: 'not_displayed', citations: [], diagnostics };
  }

  #parseFailure(diagnostics, diagnostic, reason) {
    diagnostic.parsed_citations = [];
    diagnostics.first_failure = {
      trigger_position: diagnostic.trigger_position,
      expected_idx: diagnostic.expected_idx,
      current_idx: diagnostic.current_idx,
      stage: diagnostic.failure_stage,
      reason: diagnostic.failure_reason
    };
    return {
      status: 'parse_failed',
      citations: [],
      reason,
      diagnostics
    };
  }

  async #resetCitationPopup(responseRoot) {
    const startedAt = Date.now();
    try {
      await this.#hoverResponseNeutralArea(responseRoot);
    } catch (_error) {
      return {
        cleared: false,
        elapsed_ms: Date.now() - startedAt,
        visible_count: await this.page.locator(`${POPUP_SELECTOR}:visible`).count().catch(() => null),
        failure_stage: 'popup_reset_neutral_area',
        failure_reason: 'response_scoped_neutral_area_unavailable'
      };
    }
    while (Date.now() - startedAt < POPUP_RESET_TIMEOUT_MS) {
      const visibleCount = await this.page.locator(`${POPUP_SELECTOR}:visible`).count();
      if (visibleCount === 0) {
        return {
          cleared: true,
          elapsed_ms: Date.now() - startedAt,
          visible_count: 0,
          failure_stage: null,
          failure_reason: null
        };
      }
      await this.page.waitForTimeout(100);
    }
    return {
      cleared: false,
      elapsed_ms: Date.now() - startedAt,
      visible_count: await this.page.locator(`${POPUP_SELECTOR}:visible`).count(),
      failure_stage: 'popup_reset_timeout',
      failure_reason: 'visible_citation_popup_did_not_clear'
    };
  }

  async #hoverResponseNeutralArea(responseRoot) {
    const finalAnswer = responseRoot.locator(YUANBAO_FINAL_ANSWER_SELECTOR).last();
    const isNeutral = (locator) => locator.isVisible().catch(() => false).then(async (visible) => {
      if (!visible) return false;
      return locator.evaluate((element, triggerSelector) => {
        if (element.matches(triggerSelector) || element.closest(triggerSelector) || element.querySelector(triggerSelector)) return false;
        if (element.matches('a,button,[role="button"]') || element.closest('a,button,[role="button"]') || element.querySelector('a,button,[role="button"]')) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && String(element.innerText || '').replace(/\s+/g, ' ').trim().length > 0;
      }, YUANBAO_CITATION_TRIGGER_SELECTOR).catch(() => false);
    });

    if (await isNeutral(finalAnswer)) {
      await finalAnswer.hover();
      return;
    }
    const candidates = finalAnswer.locator('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,span,div');
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await isNeutral(candidate)) {
        await candidate.hover();
        return;
      }
    }
    throw new Error('No response-scoped neutral area is available for Citation popup reset.');
  }

  async #openPopupForTrigger(trigger, sourceIndexes, diagnostic) {
    const priorPopups = await this.page.locator(`${POPUP_SELECTOR}:visible`).elementHandles();
    await this.page.mouse.move(1, 1);
    await trigger.scrollIntoViewIfNeeded();
    diagnostic.hover_started = true;
    await trigger.hover();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const popups = this.page.locator(`${POPUP_SELECTOR}:visible`);
      const popupCount = await popups.count();
      diagnostic.popup_visible ||= popupCount > 0;
      // Yuanbao can leave the prior hover popup visible briefly while mounting
      // the popup for the next trigger. The newest matching popup is the one
      // opened by this hover; an older popup may share a source index. Do not
      // accept any popup that was already visible before the current hover.
      for (let index = popupCount - 1; index >= 0; index -= 1) {
        const popup = popups.nth(index);
        const wasVisibleBeforeHover = await popup.evaluate((element, previousPopups) => previousPopups.includes(element), priorPopups);
        if (wasVisibleBeforeHover) continue;
        diagnostic.popup_found = true;
        const card = popup.locator(CARD_SELECTOR).last();
        diagnostic.card_found ||= (await card.count()) > 0;
        if (await isVisible(card) && sourceIndexes.includes(String(await card.getAttribute('data-idx')))) return { popup };
        diagnostic.current_idx = await card.getAttribute('data-idx').catch(() => null);
        diagnostic.data_url_present = Boolean(await card.getAttribute('data-url').catch(() => null));
      }
      await this.page.waitForTimeout(100);
    }
    return { popup: null };
  }

  async #readCarousel(popup, sourceIndexes, diagnostic) {
    const length = Number.parseInt(await popup.locator('.hyc-common-markdown__ref-list__content').getAttribute('data-length') || '0', 10);
    if (!Number.isInteger(length) || length !== sourceIndexes.length) {
      markFailure(diagnostic, 'carousel_length', `data_length_mismatch:${length}:${sourceIndexes.length}`);
      return { cards: [], failure: true };
    }
    const cards = [];
    let activePopup = popup;
    for (let index = 0; index < length; index += 1) {
      const step = {
        source_position: index + 1,
        expected_idx: sourceIndexes[index],
        current_idx: null,
        card_found: false,
        data_url_present: false,
        next_arrow_found: null,
        next_arrow_click: false,
        dom_remounted: null,
        popup_reacquired: false,
        card_reacquired: false,
        new_idx: null,
        failure_stage: null,
        failure_reason: null
      };
      diagnostic.carousel_steps.push(step);
      applyStepToTrigger(diagnostic, step);
      const card = activePopup.locator(CARD_SELECTOR).last();
      step.card_found = (await card.count()) > 0;
      step.current_idx = await card.getAttribute('data-idx').catch(() => null);
      step.data_url_present = Boolean(await card.getAttribute('data-url').catch(() => null));
      applyStepToTrigger(diagnostic, step);
      if (!step.card_found || !(await isVisible(card))) {
        markFailure(step, 'card_read', 'card_not_visible');
        applyStepToTrigger(diagnostic, step);
        return { cards: [], failure: true };
      }
      const entry = await card.evaluate((element) => ({
        dataIdx: element.getAttribute('data-idx'),
        dataUrl: element.getAttribute('data-url'),
        title: String(element.querySelector('.hyc-common-markdown__ref_card-title')?.textContent || '').replace(/\s+/g, ' ').trim() || null,
        sourceSite: String(element.querySelector('.hyc-common-markdown__ref_card-foot__source_txt')?.textContent || '').replace(/\s+/g, ' ').trim() || null
      }));
      step.current_idx = entry.dataIdx;
      step.data_url_present = Boolean(entry.dataUrl);
      applyStepToTrigger(diagnostic, step);
      if (!entry.dataIdx) {
        markFailure(step, 'card_data', 'missing_data_idx');
        applyStepToTrigger(diagnostic, step);
        return { cards: [], failure: true };
      }
      if (!entry.dataUrl) {
        markFailure(step, 'card_data', 'missing_data_url');
        applyStepToTrigger(diagnostic, step);
        return { cards: [], failure: true };
      }
      if (cards.some((prior) => prior.dataIdx === entry.dataIdx && prior.dataUrl === entry.dataUrl)) {
        markFailure(step, 'duplicate_card', 'duplicate_data_idx_and_url');
        applyStepToTrigger(diagnostic, step);
        return { cards: [], failure: true };
      }
      cards.push(entry);
      if (index + 1 < length) {
        const nextButtons = activePopup.locator(NEXT_CARD_SELECTOR);
        step.next_arrow_found = (await nextButtons.count()) > 0;
        applyStepToTrigger(diagnostic, step);
        if (!step.next_arrow_found) {
          markFailure(step, 'next_arrow', 'next_arrow_unavailable');
          applyStepToTrigger(diagnostic, step);
          return { cards: [], failure: true };
        }
        const previousCardHandle = await card.elementHandle().catch(() => null);
        step.next_arrow_click = true;
        await nextButtons.last().click();
        // Yuanbao remounts its hover popup/card after advancing. Do not retain
        // the pre-click locator: locate the new visible popup from page root.
        const transition = await this.#awaitNextPopupFromPage(sourceIndexes, length, entry.dataIdx, previousCardHandle);
        await previousCardHandle?.dispose().catch(() => {});
        const { popup: nextPopup, ...transitionDiagnostic } = transition;
        Object.assign(step, transitionDiagnostic);
        applyStepToTrigger(diagnostic, step);
        if (!nextPopup) {
          markFailure(step, transition.failure_stage, transition.failure_reason);
          applyStepToTrigger(diagnostic, step);
          return { cards: [], failure: true };
        }
        activePopup = nextPopup;
      }
    }
    return { cards, failure: false };
  }

  async #awaitNextPopupFromPage(sourceIndexes, length, previousIndex, previousCardHandle) {
    const deadline = Date.now() + 2_000;
    let sawVisiblePopup = false;
    let sawLengthMatch = false;
    let sawCard = false;
    let sawVisibleCard = false;
    let sawCurrentIndex = false;
    let sawChangedIndex = false;
    let lastCurrentIndex = null;
    while (Date.now() < deadline) {
      const popups = this.page.locator(`${POPUP_SELECTOR}:visible`);
      sawVisiblePopup ||= (await popups.count()) > 0;
      for (let index = (await popups.count()) - 1; index >= 0; index -= 1) {
        const candidate = popups.nth(index);
        const content = candidate.locator('.hyc-common-markdown__ref-list__content');
        if (Number.parseInt(await content.getAttribute('data-length') || '0', 10) !== length) continue;
        sawLengthMatch = true;
        const card = candidate.locator(CARD_SELECTOR).last();
        sawCard ||= (await card.count()) > 0;
        if (!(await isVisible(card))) continue;
        sawVisibleCard = true;
        const currentIndex = await card.getAttribute('data-idx');
        lastCurrentIndex = currentIndex;
        if (!currentIndex) continue;
        sawCurrentIndex = true;
        if (currentIndex === previousIndex) continue;
        sawChangedIndex = true;
        if (!sourceIndexes.includes(currentIndex)) continue;
        const nextCardHandle = await card.elementHandle().catch(() => null);
        const domRemounted = previousCardHandle && nextCardHandle
          ? await nextCardHandle.evaluate((element, previous) => element !== previous, previousCardHandle).catch(() => true)
          : null;
        await nextCardHandle?.dispose().catch(() => {});
        return {
          current_idx: previousIndex,
          new_idx: currentIndex,
          dom_remounted: domRemounted,
          popup_reacquired: true,
          card_reacquired: true,
          failure_stage: null,
          failure_reason: null,
          popup: candidate
        };
      }
      await this.page.waitForTimeout(100);
    }
    if (!sawVisiblePopup || !sawLengthMatch) {
      return {
        current_idx: lastCurrentIndex,
        new_idx: lastCurrentIndex,
        dom_remounted: null,
        popup_reacquired: false,
        card_reacquired: false,
        failure_stage: 'popup_reacquire',
        failure_reason: !sawVisiblePopup ? 'no_visible_popup_after_next_click' : 'popup_data_length_mismatch',
        popup: null
      };
    }
    return {
      current_idx: lastCurrentIndex,
      new_idx: lastCurrentIndex,
      dom_remounted: null,
      popup_reacquired: false,
      card_reacquired: false,
      failure_stage: 'card_reacquire',
      failure_reason: !sawCard || !sawVisibleCard
        ? 'card_not_reacquired'
        : !sawCurrentIndex
          ? 'card_data_idx_missing'
          : !sawChangedIndex
            ? 'card_data_idx_not_changed'
            : 'card_data_idx_unexpected',
      popup: null
    };
  }
}
