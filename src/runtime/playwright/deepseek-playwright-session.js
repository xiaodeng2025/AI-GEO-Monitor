import { DeepSeekAdapter } from '../../platforms/deepseek/deepseek-adapter.js';
import {
  collapseDeepSeekSidebarForSnapshot,
  expandDeepSeekSourcePanelForSnapshot,
  materializeDeepSeekSourcesForSnapshot
} from './deepseek-dead-snapshot.js';
import { snapshotDispatcher } from './snapshot-registry.js';

async function prepareDeepSeekSnapshot(page) {
  const sidebar = await collapseDeepSeekSidebarForSnapshot({ page });
  const sourcePanel = await expandDeepSeekSourcePanelForSnapshot({ page });
  const sourceMaterialization = await materializeDeepSeekSourcesForSnapshot({ page });
  return { sidebar, sourcePanel, sourceMaterialization };
}

function snapshotResultArtifact(snapshotResult) {
  return {
    kind: 'deepseek_snapshot_result',
    fileName: 'deepseek-snapshot-result.json',
    content: `${JSON.stringify(snapshotResult, null, 2)}\n`
  };
}

/**
 * Owns the DeepSeek Playwright session. No Page/Locator reaches its caller:
 * the EvidenceProvider consumes all runtime handles before this returns.
 */
export class DeepSeekPlaywrightSession {
  constructor({
    runtime,
    evidenceProvider,
    adapterFactory = (page) => new DeepSeekAdapter(page),
    dispatcher = snapshotDispatcher,
    snapshotPreparer = prepareDeepSeekSnapshot
  }) {
    this.runtime = runtime;
    this.evidenceProvider = evidenceProvider;
    this.adapterFactory = adapterFactory;
    this.dispatcher = dispatcher;
    this.snapshotPreparer = snapshotPreparer;
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
      const observation = await adapter.observeSourcePool(responseRoot);
      const citationArtifacts = await this.evidenceProvider.materializeCitationEvidence(null);
      const acquisitionResult = {
        answer: answerMaterialized.answer,
        citations: { status: citations.status, citations: citations.citations },
        observation
      };
      // Snapshot follows the completed acquisition. Its result and artifacts
      // stay supplementary, so a failure cannot change acquisition semantics.
      let snapshotResult = { status: 'failed', artifact_reference: null, bytes: null, captured_at: null, error: 'Snapshot was not attempted.' };
      let snapshotArtifacts = [];
      try {
        const preparation = await this.snapshotPreparer(page);
        const dispatched = await this.dispatcher.captureWithArtifacts({ platform: 'deepseek', context: { page, preparation } });
        snapshotResult = dispatched.snapshot_result;
        snapshotArtifacts = dispatched.artifacts;
      } catch (snapshotError) {
        snapshotResult = {
          status: 'failed', artifact_reference: null, bytes: null, captured_at: null,
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
        };
      }
      console.info('[AI-GEO DeepSeek snapshot]', JSON.stringify({ status: snapshotResult.status, error: snapshotResult.error }));
      const terminalContextArtifacts = typeof this.evidenceProvider.materializeTerminalContext === 'function'
        ? await this.evidenceProvider.materializeTerminalContext({ page, answerHandle: answerObservation.evidenceRoot })
        : [];

      return {
        ...acquisitionResult,
        snapshot_result: snapshotResult,
        artifacts: {
          answer: answerMaterialized.artifacts,
          citation: [...citationArtifacts, ...snapshotArtifacts, snapshotResultArtifact(snapshotResult), ...terminalContextArtifacts]
        }
      };
    } catch (error) {
      const failureArtifacts = await this.evidenceProvider.materializeFailure({ page });
      Object.assign(error, { failureArtifacts });
      throw error;
    }
  }
}
