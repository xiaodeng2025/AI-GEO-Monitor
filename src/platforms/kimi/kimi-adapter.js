import { fingerprint } from '../../core/hash.js';
import { PlatformAdapter } from '../../core/types.js';

const KIMI_HOME = 'https://www.kimi.com/';
const RESPONSE_ROOT_SELECTOR = [
  '.segment.segment-assistant',
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '[data-testid*="assistant"]'
].join(', ');
const STOP_SELECTOR = [
  '[aria-label*="停止"]', '[aria-label*="Stop"]',
  'button:has-text("停止生成")', 'button:has-text("Stop generating")',
  '.stop-button', '[data-testid*="stop"]'
].join(', ');
const EXPLICIT_CITATION_SELECTOR = [
  'a.pua-ref-cite-tag[href][data-site-name]',
  '[data-citation-id]', '[data-source-id]', '[data-reference-id]',
  '[aria-label*="引用"]', '[aria-label*="来源"]',
  '[title*="引用"]', '[title*="来源"]',
  '.citation', '.citation-link', '.reference-link'
].join(', ');
const PANEL_SELECTOR = [
  '[role="dialog"]', '[data-source-panel]', '[data-citation-panel]',
  '[class*="source"][class*="panel"]', '[class*="reference"][class*="panel"]',
  '[class*="citation"][class*="panel"]'
].join(', ');
const TRIGGER_TEXT = /(?:引用来源|参考来源|查看.{0,6}来源|来源\s*\d*)/;

export const KIMI_CAPABILITY = Object.freeze({
  platform: 'Kimi Web',
  answer: true,
  citation_capture: 'trigger_bound',
  citation_title: true,
  citation_url: true,
  citation_domain: true,
  citation_position: true
});

function visible(locator) {
  return locator.isVisible().catch(() => false);
}

export async function anyVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await visible(locator.nth(index))) return true;
  }
  return false;
}

function cleanText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export class KimiAdapter extends PlatformAdapter {
  constructor(page) {
    super();
    this.page = page;
  }

  get name() { return 'Kimi Web'; }

  get capability() {
    return KIMI_CAPABILITY;
  }

  async startFreshChat() {
    await this.page.goto(KIMI_HOME, { waitUntil: 'domcontentloaded' });
    await this.page.locator('.chat-input-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 20_000 });
    if (await visible(this.page.getByRole('button', { name: /^登录$/ }))) {
      const error = new Error('Kimi manual login is required in profiles/kimi before a monitored run.');
      error.code = 'MANUAL_LOGIN_REQUIRED';
      throw error;
    }
    const freshChat = this.page.locator('a.new-chat-btn, a[href*="chat_enter_method=new_chat"]').first();
    if (!(await visible(freshChat))) throw new Error('Kimi fresh-chat control was not visible.');
    await freshChat.click();
    await this.page.locator('.chat-input-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 10_000 });
  }

  async captureBaseline() {
    return this.#responseSnapshot();
  }

  async submitPrompt(text) {
    const editor = this.page.locator('.chat-input-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]').first();
    await editor.fill(text);
    const send = this.page.locator('.send-button-container:not(.disabled), [aria-label*="发送"], button[type="submit"]').first();
    await send.waitFor({ state: 'visible', timeout: 10_000 });
    await send.click();
  }

  async waitForResponse(baseline, timeoutMs) {
    let lastFingerprint = null;
    let stableSince = null;
    let lastProgressAt = Date.now();
    while (true) {
      const response = await this.locateResponseRoot(baseline);
      if (response) {
        // Kimi exposes thinking/search toolcalls inside the assistant root before
        // the final answer. Toolcall text is not an answer-completion signal.
        const text = await this.#finalAnswerText(response);
        const currentFingerprint = fingerprint(text);
        if (currentFingerprint !== lastFingerprint) {
          lastFingerprint = currentFingerprint;
          stableSince = Date.now();
          lastProgressAt = Date.now();
        }
        const generating = await anyVisible(this.page.locator(STOP_SELECTOR));
        const stableForMs = stableSince ? Date.now() - stableSince : 0;
        if (!generating && text.length > 0 && stableForMs >= 3_000) return;
      }
      if (Date.now() - lastProgressAt >= timeoutMs) {
        const error = new Error(`Kimi response made no observable progress for ${timeoutMs} ms.`);
        error.code = 'ANSWER_TIMEOUT';
        throw error;
      }
      await this.page.waitForTimeout(750);
    }
  }

  async locateResponseRoot(baseline) {
    const current = await this.#responseSnapshot();
    if (current.count > baseline.count) return this.page.locator(RESPONSE_ROOT_SELECTOR).nth(current.count - 1);
    if (current.count === baseline.count && current.lastFingerprint && current.lastFingerprint !== baseline.lastFingerprint) {
      return this.page.locator(RESPONSE_ROOT_SELECTOR).nth(current.count - 1);
    }
    return null;
  }

  async extractAnswer(responseRoot) {
    const evidenceRoot = this.#finalAnswerMarkdown(responseRoot);
    if (!(await visible(evidenceRoot))) throw new Error('Kimi response root has no non-toolcall final answer text.');
    const text = cleanText(await evidenceRoot.innerText().catch(() => ''));
    if (!text) throw new Error('Kimi response root has no non-toolcall final answer text.');
    return { text, fingerprint: fingerprint(text), evidenceRoot };
  }

  async extractCitations(responseRoot) {
    const contained = await this.#readContained(responseRoot);
    if (contained.length > 0) {
      return { status: 'captured', citations: contained, panel: responseRoot };
    }

    const trigger = await this.#findSingleTrigger(responseRoot);
    if (!trigger) return { status: 'not_displayed', citations: [] };
    const panel = await this.#openBoundPanel(trigger);
    if (!panel) return { status: 'parse_failed', citations: [] };
    const citations = await this.#readPanel(panel);
    if (citations.length === 0) return { status: 'parse_failed', citations: [] };
    return { status: 'captured', citations, panel };
  }

  async #responseSnapshot() {
    const roots = this.page.locator(RESPONSE_ROOT_SELECTOR);
    const count = await roots.count();
    if (count === 0) return { count: 0, lastFingerprint: null };
    const lastText = cleanText(await roots.nth(count - 1).innerText().catch(() => ''));
    return { count, lastFingerprint: fingerprint(lastText) };
  }

  async #finalAnswerText(responseRoot) {
    const finalMarkdown = this.#finalAnswerMarkdown(responseRoot);
    if (!(await visible(finalMarkdown))) return '';
    return cleanText(await finalMarkdown.innerText().catch(() => ''));
  }

  #finalAnswerMarkdown(responseRoot) {
    return responseRoot.locator('.markdown-container:not(.toolcall-content-text) .markdown').last();
  }

  async #readContained(responseRoot) {
    const entries = await responseRoot.evaluate((root, selector) => {
      const candidates = [...root.querySelectorAll(selector)];
      const seenLinks = new Set();
      const entries = [];
      for (const node of candidates) {
        const links = node.matches('a[href]') ? [node] : [...node.querySelectorAll('a[href]')];
        for (const link of links) {
          if (seenLinks.has(link)) continue;
          seenLinks.add(link);
          const title = (link.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim() || null;
          const displayDomain = node.getAttribute('data-domain') || node.querySelector('[class*="domain"]')?.textContent?.trim() || null;
          entries.push({ position: entries.length + 1, title, link_url: link.href || null, display_domain: displayDomain, association_method: 'contained' });
        }
      }
      return entries;
    }, EXPLICIT_CITATION_SELECTOR);
    return entries;
  }

  async #findSingleTrigger(responseRoot) {
    const triggers = responseRoot.locator('button, [role="button"], [aria-controls]');
    const count = await triggers.count();
    const matches = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = triggers.nth(index);
      if (!(await visible(candidate))) continue;
      const label = cleanText(`${await candidate.innerText().catch(() => '')} ${await candidate.getAttribute('aria-label').catch(() => '') ?? ''} ${await candidate.getAttribute('title').catch(() => '') ?? ''}`);
      if (TRIGGER_TEXT.test(label)) matches.push(candidate);
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }

  async #openBoundPanel(trigger) {
    const controls = await trigger.getAttribute('aria-controls');
    const before = new Set(await this.#visiblePanelIds());
    await trigger.click();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (controls) {
        const escapedControlId = controls.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const controlled = this.page.locator(`[id="${escapedControlId}"]`).first();
        if (await visible(controlled)) return controlled;
      }
      const panels = this.page.locator(PANEL_SELECTOR);
      const count = await panels.count();
      const newPanels = [];
      for (let index = 0; index < count; index += 1) {
        const panel = panels.nth(index);
        if (!(await visible(panel))) continue;
        const id = await panel.evaluate((element) => element.id || element.outerHTML.slice(0, 160));
        if (!before.has(id)) newPanels.push(panel);
      }
      if (newPanels.length === 1) return newPanels[0];
      await this.page.waitForTimeout(250);
    }
    return null;
  }

  async #visiblePanelIds() {
    const panels = this.page.locator(PANEL_SELECTOR);
    const ids = [];
    for (let index = 0; index < await panels.count(); index += 1) {
      const panel = panels.nth(index);
      if (await visible(panel)) ids.push(await panel.evaluate((element) => element.id || element.outerHTML.slice(0, 160)));
    }
    return ids;
  }

  async #readPanel(panel) {
    const entries = await panel.evaluate((root) => {
      const itemSelector = '[data-source-id], [data-citation-id], [data-reference-id], [class*="source-card"], [class*="reference-card"], [class*="citation-card"], a[href]';
      const items = [...root.querySelectorAll(itemSelector)];
      const seen = new Set();
      return items.flatMap((item, index) => {
        const links = item.matches('a[href]') ? [item] : [...item.querySelectorAll('a[href]')];
        return links.map((link) => {
          if (seen.has(link.href)) return null;
          seen.add(link.href);
          const title = (link.textContent || item.textContent || '').replace(/\s+/g, ' ').trim() || null;
          const displayDomain = item.getAttribute('data-domain') || item.querySelector('[class*="domain"]')?.textContent?.trim() || null;
          return { position: index + 1, title, link_url: link.href || null, display_domain: displayDomain, association_method: 'trigger_bound' };
        }).filter(Boolean);
      });
    });
    return entries;
  }
}
