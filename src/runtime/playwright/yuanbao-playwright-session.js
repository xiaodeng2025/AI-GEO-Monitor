import { YuanbaoAdapter } from '../../platforms/yuanbao/yuanbao-adapter.js';

/**
 * Owns the Yuanbao Playwright session. Popup and carousel handles never leave
 * this session/provider boundary, including after a DOM remount.
 */
export class YuanbaoPlaywrightSession {
  constructor({ runtime, evidenceProvider, adapterFactory = (page) => new YuanbaoAdapter(page) }) {
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
      const observation = await adapter.observeSourcePool(responseRoot);
      const citations = await adapter.extractCitations(responseRoot);
      const firstFailure = citations.diagnostics?.first_failure;
      if (firstFailure) {
        console.error(`Citation replay failed: trigger=${firstFailure.trigger_position} expected_idx=${firstFailure.expected_idx ?? 'null'} stage=${firstFailure.stage}`);
      }
      let citationArtifacts = [];
      if (citations.diagnostics && typeof this.evidenceProvider.materializeCitationReplayDiagnostics === 'function') {
        try {
          citationArtifacts.push(...await this.evidenceProvider.materializeCitationReplayDiagnostics(citations.diagnostics));
        } catch (_error) {
          // Diagnostic artifacts are best-effort and must not change Citation semantics.
        }
      }
      if (citations.panel) {
        try {
          citationArtifacts.push(...await this.evidenceProvider.materializeCitationEvidence({ handle: citations.panel }));
        } catch (_error) {
          // Popup/card evidence is supplementary; keep parsed Citation semantics.
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
        observation,
        artifacts: {
          answer: answerMaterialized.artifacts,
          citation: [...citationArtifacts, ...terminalContextArtifacts]
        }
      };
    } catch (error) {
      let failureArtifacts = [];
      try {
        failureArtifacts = await this.evidenceProvider.materializeFailure({ page });
      } catch (_failureCaptureError) {
        // Failure screenshot is best-effort and must not mask the original error.
      }
      Object.assign(error, { failureArtifacts });
      throw error;
    }
  }
}
