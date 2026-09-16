import { fingerprint } from '../../core/hash.js';
import { PlatformAdapter } from '../../core/types.js';

const HOME = 'https://chat.deepseek.com/';
export const DEEPSEEK_RESPONSE_ROOT_SELECTOR = '.ds-message:has(.ds-assistant-message-main-content)';
export const DEEPSEEK_FINAL_ANSWER_SELECTOR = '.ds-markdown.ds-assistant-message-main-content';
export const DEEPSEEK_CITATION_SELECTOR = `${DEEPSEEK_FINAL_ANSWER_SELECTOR} .ds-markdown-cite`;
const EDITOR_SELECTOR = 'textarea[placeholder^="给 DeepSeek 发送消息"]';
const GENERATING_SELECTOR = '[aria-busy="true"], button:has-text("停止生成"), [role="button"]:has-text("停止生成"), button:has-text("Stop generating"), [role="button"]:has-text("Stop generating")';

export const DEEPSEEK_CAPABILITY = Object.freeze({
  platform: 'DeepSeek Web', answer: true, citation_capture: 'trigger_bound',
  citation_title: false, citation_url: true, citation_domain: false, citation_position: true
});

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function visible(locator) { return locator.isVisible().catch(() => false); }

export class DeepSeekAdapter extends PlatformAdapter {
  constructor(page) { super(); this.page = page; }
  get name() { return 'DeepSeek Web'; }
  get capability() { return DEEPSEEK_CAPABILITY; }

  async startFreshChat() {
    await this.page.goto(HOME, { waitUntil: 'domcontentloaded' });
    const fresh = this.page.getByText('开启新对话', { exact: true }).first();
    // The platform persists its native sidebar state. Restore the normal fresh
    // chat entry point only when its established two-control sidebar header is
    // present; no application state, prompt, or response DOM is changed here.
    if (!(await visible(fresh))) {
      // In collapsed mode DeepSeek renders a different, visible three-icon
      // header. Its first icon is the native sidebar toggle (the other two are
      // search and new conversation); the expanded-header controls remain in
      // the DOM but are hidden, so they must not be used here.
      const collapsedToggle = this.page.locator('[role="button"]', {
        has: this.page.locator('svg path[d^="M9.67272 0.522841"]')
      }).first();
      if (await visible(collapsedToggle)) {
        await collapsedToggle.click();
        await fresh.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
      }
    }
    if (!(await visible(fresh))) throw new Error('DeepSeek fresh-chat control was not visible.');
    await fresh.click();
    await this.page.locator(EDITOR_SELECTOR).first().waitFor({ state: 'visible', timeout: 10_000 });
  }

  async captureBaseline() { return this.#responseSnapshot(); }

  async submitPrompt(text) {
    const editor = this.page.locator(EDITOR_SELECTOR).first();
    if (!(await visible(editor)) || clean(await editor.inputValue())) throw new Error('DeepSeek fresh-chat editor is unavailable or non-empty.');
    await editor.fill(text);
    const composer = editor.locator('xpath=ancestor::div[.//*[@role="button"]][1]');
    const send = composer.locator('[role="button"]').last();
    if (!(await visible(send))) throw new Error('DeepSeek send control was not visible.');
    const disabled = await send.evaluate((element) => typeof element.className === 'string' && element.className.split(/\s+/).includes('ds-button--disabled'));
    if (disabled) throw new Error('DeepSeek send control remained disabled after entering the Prompt.');
    await send.click();
  }

  async waitForResponse(baseline, timeoutMs) {
    let lastFingerprint = null;
    let changedAt = null;
    let lastProgressAt = Date.now();
    while (true) {
      const response = await this.locateResponseRoot(baseline);
      if (response) {
        const final = this.#finalAnswer(response);
        const text = await visible(final) ? clean(await final.innerText().catch(() => '')) : '';
        const currentFingerprint = fingerprint(text);
        if (currentFingerprint !== lastFingerprint) {
          lastFingerprint = currentFingerprint;
          changedAt = Date.now();
          lastProgressAt = Date.now();
        }
        const generating = await this.#isGenerating();
        if (text && !generating && changedAt !== null && Date.now() - changedAt >= 1_000) return;
      }
      if (Date.now() - lastProgressAt >= timeoutMs) {
        const error = new Error(`DeepSeek response made no observable progress for ${timeoutMs} ms.`);
        error.code = 'ANSWER_TIMEOUT';
        throw error;
      }
      await this.page.waitForTimeout(250);
    }
  }

  async locateResponseRoot(baseline) {
    const current = await this.#responseSnapshot();
    if (current.count > baseline.count) return this.page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR).nth(current.count - 1);
    if (current.count === baseline.count && current.lastFingerprint && current.lastFingerprint !== baseline.lastFingerprint) {
      return this.page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR).nth(current.count - 1);
    }
    return null;
  }

  async extractAnswer(responseRoot) {
    const evidenceRoot = this.#finalAnswer(responseRoot);
    if (!(await visible(evidenceRoot))) throw new Error('DeepSeek response has no visible final Markdown.');
    const text = clean(await evidenceRoot.innerText());
    if (!text) throw new Error('DeepSeek response has no final-answer text.');
    return { text, fingerprint: fingerprint(text), evidenceRoot };
  }

  async observeSourcePool(responseRoot) {
    const sourceCount = await responseRoot.evaluate((root) => {
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const sourceLabels = [...root.querySelectorAll('*')]
        .map((element) => cleanText(element.innerText))
        .filter((text) => /^(?:已阅读\s*)?\d+\s*个网页$/.test(text));
      return sourceLabels[0] ? Number(sourceLabels[0].match(/\d+/)[0]) : null;
    });
    return { platform_reported_source_count: sourceCount };
  }

  async extractCitations(responseRoot) {
    const result = await responseRoot.evaluate((root) => {
      const final = root.querySelector('.ds-markdown.ds-assistant-message-main-content');
      if (!final) return { citations: [], missingHref: false };
      const citations = [...final.querySelectorAll('.ds-markdown-cite')].map((node, index) => {
        const link = node.closest('a[href]');
        return { position: index + 1, link_url: link?.href || null, title: null, display_domain: null, association_method: 'trigger_bound' };
      });
      return { citations, missingHref: citations.some((citation) => !citation.link_url) };
    });
    if (result.missingHref) return { status: 'parse_failed', citations: [] };
    return {
      status: result.citations.length > 0 ? 'captured' : 'not_displayed',
      citations: result.citations
    };
  }

  #finalAnswer(responseRoot) { return responseRoot.locator(DEEPSEEK_FINAL_ANSWER_SELECTOR).last(); }

  async #responseSnapshot() {
    const roots = this.page.locator(DEEPSEEK_RESPONSE_ROOT_SELECTOR);
    const count = await roots.count();
    if (count === 0) return { count: 0, lastFingerprint: null };
    const text = clean(await roots.nth(count - 1).innerText().catch(() => ''));
    return { count, lastFingerprint: fingerprint(text) };
  }

  async #isGenerating() {
    const controls = this.page.locator(GENERATING_SELECTOR);
    for (let index = 0; index < await controls.count(); index += 1) {
      if (await visible(controls.nth(index))) return true;
    }
    return false;
  }
}
