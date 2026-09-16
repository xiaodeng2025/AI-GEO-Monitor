import { KimiAdapter } from '../../platforms/kimi/kimi-adapter.js';

/**
 * Owns the Kimi Playwright session. Runtime handles are consumed here or by
 * the EvidenceProvider before a plain result is returned to Core.
 */
export class KimiPlaywrightSession {
  constructor({ runtime, evidenceProvider, adapterFactory = (page) => new KimiAdapter(page) }) {
    this.runtime = runtime;
    this.evidenceProvider = evidenceProvider;
    this.adapterFactory = adapterFactory;
  }

  async close() {
    await this.runtime.close();
  }

  async run({ promptText, timeoutMs }) {
    let page = null;
    try {
      page = await this.runtime.newPage();
      const adapter = this.adapterFactory(page);
      await adapter.startFreshChat();
      const baseline = await adapter.captureBaseline();
      await adapter.submitPrompt(promptText);
      await adapter.waitForResponse(baseline, timeoutMs);
      const responseRoot = await adapter.locateResponseRoot(baseline);
      if (!responseRoot) throw new Error('No new completed response root matched the pre-submit baseline.');

      const answerObservation = await adapter.extractAnswer(responseRoot);
      const answerMaterialized = await this.evidenceProvider.materializeAnswer({
        handle: answerObservation.evidenceRoot,
        text: answerObservation.text,
        fingerprint: answerObservation.fingerprint
      });
      const citations = await adapter.extractCitations(responseRoot);
      let citationArtifacts = [];
      if (citations.panel) {
        try {
          citationArtifacts = await this.evidenceProvider.materializeCitationEvidence({ handle: citations.panel });
        } catch (_error) {
          // Supplementary capture is best-effort; keep parsed Citation semantics.
        }
      }
      const terminalContextArtifacts = typeof this.evidenceProvider.materializeTerminalContext === 'function'
        ? await this.evidenceProvider.materializeTerminalContext({ page, answerHandle: answerObservation.evidenceRoot })
        : [];

      return {
        answer: answerMaterialized.answer,
        citations: {
          status: citations.status,
          citations: citations.citations
        },
        observation: { platform_reported_source_count: null },
        artifacts: {
          answer: answerMaterialized.artifacts,
          citation: [...citationArtifacts, ...terminalContextArtifacts]
        }
      };
    } catch (error) {
      const failureArtifacts = await this.evidenceProvider.materializeFailure({ page });
      Object.assign(error, { failureArtifacts });
      throw error;
    }
  }
}
