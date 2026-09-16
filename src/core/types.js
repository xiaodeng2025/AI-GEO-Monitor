export const ANSWER_STATUS = Object.freeze(['captured', 'timeout', 'failed']);
export const CITATION_STATUS = Object.freeze([
  'captured',
  'not_displayed',
  'unsupported',
  'parse_failed',
  'unattributed'
]);
export const ASSOCIATION_METHOD = Object.freeze(['contained', 'trigger_bound', 'none']);

/**
 * PlatformAdapter is intentionally small. The runner owns persistence, retries,
 * artifacts and text analysis; an adapter owns only platform UI behavior.
 */
export class PlatformAdapter {
  get name() {
    throw new Error('PlatformAdapter.name must be implemented');
  }

  get capability() {
    throw new Error('PlatformAdapter.capability must be implemented');
  }

  async startFreshChat() { throw new Error('Not implemented'); }
  async captureBaseline() { throw new Error('Not implemented'); }
  async submitPrompt() { throw new Error('Not implemented'); }
  async waitForResponse() { throw new Error('Not implemented'); }
  async locateResponseRoot() { throw new Error('Not implemented'); }
  async extractAnswer() { throw new Error('Not implemented'); }
  async extractCitations() { throw new Error('Not implemented'); }
}
