import { fingerprint } from '../../core/hash.js';
import { PlatformAdapter } from '../../core/types.js';
import { readLifecycleObservation } from '../../yuanbao-lifecycle-observer.js';
import { YuanbaoResponseDom } from './yuanbao-response-dom.js';

const HOME = 'https://yuanbao.tencent.com/';
const EDITOR = '.ql-editor[contenteditable="true"]';

export const YUANBAO_CAPABILITY = Object.freeze({
  platform: 'Tencent Yuanbao Web', answer: true, citation_capture: 'trigger_bound',
  citation_title: true, citation_url: true, citation_domain: false, citation_position: true
});

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export class YuanbaoAdapter extends PlatformAdapter {
  constructor(page) { super(); this.page = page; this.dom = new YuanbaoResponseDom(page); }
  get name() { return 'Tencent Yuanbao Web'; }
  get capability() { return YUANBAO_CAPABILITY; }
  async startFreshChat() {
    await this.page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2_000);
    const activated = await this.page.evaluate(() => {
      const text = (node) => String(node.innerText || '').replace(/\s+/g, ' ').trim();
      const item = [...document.querySelectorAll('*')].find((node) => text(node) === '新对话' && ![...node.children].some((child) => text(child) === '新对话'));
      if (!item || !item.getClientRects().length) return false;
      (item.closest('button,[role="button"],a,[onclick]') || item).click(); return true;
    });
    if (!activated) throw new Error('Fresh-chat control was not available.');
    await this.page.waitForTimeout(800);
  }
  async captureBaseline() { return readLifecycleObservation(this.page); }
  async submitPrompt(prompt) {
    const editor = this.page.locator(EDITOR).first();
    if (!(await editor.isVisible()) || clean(await editor.innerText())) throw new Error('Fresh-chat editor is unavailable or non-empty.');
    await editor.click(); await this.page.keyboard.insertText(prompt);
    if (clean(await editor.innerText()) !== prompt) throw new Error('Prompt text mismatch.');
    const send = this.page.locator('[aria-label="发送"]').first();
    if (!(await send.isVisible())) throw new Error('Visible send control was not found.');
    await send.click();
  }
  async waitForResponse(baseline, timeoutMs) {
    let stableFingerprint = null; let changedAt = null;
    let lastProgressAt = Date.now();
    while (true) {
      const observation = await readLifecycleObservation(this.page);
      const latest = observation.responses.at(-1);
      if (observation.responseRootCount > baseline.responseRootCount && latest) {
        const current = latest.finalText ? fingerprint(latest.finalText) : null;
        if (current !== stableFingerprint) {
          stableFingerprint = current;
          changedAt = Date.now();
          lastProgressAt = Date.now();
        }
        if (latest.outputting === 'false' && latest.finalVisible && latest.finalText && changedAt !== null && Date.now() - changedAt >= 1_000) return;
      }
      if (Date.now() - lastProgressAt >= timeoutMs) {
        const error = new Error(`Yuanbao response made no observable progress for ${timeoutMs} ms.`);
        error.code = 'ANSWER_TIMEOUT';
        throw error;
      }
      await this.page.waitForTimeout(250);
    }
  }
  async locateResponseRoot(baseline) { return this.dom.locateCompletedResponse(baseline.responseRootCount); }
  async extractAnswer(root) { return this.dom.extractAnswer(root); }
  async observeSourcePool(root) { return this.dom.observeSourcePool(root); }
  async extractCitations(root) { return this.dom.extractCitations(root); }
}
