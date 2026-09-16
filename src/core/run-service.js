import { detectMentions } from '../analysis/mentions.js';
import { newId } from './hash.js';

function statusFor(error) {
  return error?.code === 'ANSWER_TIMEOUT' ? 'timeout' : 'failed';
}

/**
 * Shared persistence lifecycle. Runtime Sessions perform all UI work and
 * return only plain evidence to this service.
 */
export class RunService {
  constructor({ repository, artifactStore, parserVersion, timeoutMs = 90_000 }) {
    this.repository = repository;
    this.artifactStore = artifactStore;
    this.parserVersion = parserVersion;
    this.timeoutMs = timeoutMs;
  }

  beginRun({ prompt, platform, capability, runId = newId('run'), startedAt = new Date().toISOString() }) {
    this.repository.upsertCapability(capability);
    this.repository.createRun({
      run_id: runId, prompt_id: prompt.id, prompt_text: prompt.text, platform,
      started_at: startedAt, status: 'running', answer_status: 'failed',
      citation_status: 'unsupported', parser_version: this.parserVersion,
      error: 'Run started; terminal outcome not yet recorded.'
    });
    return { runId, startedAt };
  }

  /**
   * Persists a result returned by a Runtime Session after it has materialized
   * every runtime handle. This path accepts only the plain evidence bundle.
   */
  async executeRuntimeNeutral({ prompt, promptSet, lifecycle, sessionRunner }) {
    const { runId } = lifecycle;
    try {
      const evidence = await sessionRunner({ runId, promptText: prompt.text, timeoutMs: this.timeoutMs });
      if (!evidence?.answer || !evidence.citations || !evidence.observation) {
        throw new Error('Runtime Session returned an incomplete runtime-neutral evidence bundle.');
      }

      const mentions = detectMentions(evidence.answer.text, promptSet);
      const artifacts = [];
      const persistGroup = async (payloads) => {
        try {
          return await this.artifactStore.persistMaterialized(runId, payloads ?? []);
        } catch (_error) {
          // Supplementary artifact failure must not discard semantic evidence.
          return [];
        }
      };
      artifacts.push(...await persistGroup(evidence.artifacts?.answer));
      artifacts.push(...await persistGroup(evidence.artifacts?.citation));

      this.repository.saveAnswer({
        run_id: runId, answer_text: evidence.answer.text, answer_html_fragment: evidence.answer.html,
        response_fingerprint: evidence.answer.fingerprint, brand_hits: mentions.brand_hits,
        competitor_hits: mentions.competitor_mentions
      });
      for (const citation of evidence.citations.citations) {
        this.repository.saveCitation({ citation_id: newId('citation'), run_id: runId, ...citation });
      }
      for (const artifact of artifacts) this.repository.saveArtifact(artifact);
      this.repository.finishRun({
        run_id: runId, finished_at: new Date().toISOString(), status: 'completed',
        answer_status: 'captured', citation_status: evidence.citations.status,
        platform_reported_source_count: evidence.observation.platform_reported_source_count ?? null
      });
      return { runId, answerStatus: 'captured', citationStatus: evidence.citations.status, citations: evidence.citations.citations.length };
    } catch (caught) {
      const terminal = await this.failStartedRun({
        lifecycle,
        error: caught,
        failureArtifacts: Array.isArray(caught.failureArtifacts) ? caught.failureArtifacts : []
      });
      throw Object.assign(caught, { runId, ...terminal });
    }
  }

  async failStartedRun({ lifecycle, error, failureArtifacts = [] }) {
    const answerStatus = statusFor(error);
    const citationStatus = answerStatus === 'timeout' ? 'unsupported' : 'parse_failed';
    let terminalError = error;
    let artifacts = [];
    try {
      artifacts = await this.artifactStore.saveFailure(lifecycle.runId, error);
      if (failureArtifacts.length > 0) {
        artifacts.push(...await this.artifactStore.persistMaterialized(lifecycle.runId, failureArtifacts));
      }
    } catch (artifactError) {
      terminalError = new AggregateError([error, artifactError], 'Run failed and failure artifact persistence also failed.');
    }
    for (const artifact of artifacts) {
      try {
        this.repository.saveArtifact(artifact);
      } catch (artifactRecordError) {
        terminalError = new AggregateError([terminalError, artifactRecordError], 'Run failed and artifact index persistence also failed.');
      }
    }
    this.repository.finishRun({
      run_id: lifecycle.runId, finished_at: new Date().toISOString(), status: 'failed',
      answer_status: answerStatus, citation_status: citationStatus,
      error: `${terminalError.name}: ${terminalError.message}`
    });
    return { answerStatus, citationStatus };
  }

}
