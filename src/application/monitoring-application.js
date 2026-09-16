import { newId } from '../core/hash.js';
import { assertPlanExecutionOutcome } from './plan-executor.js';

const PAUSED_PLAN_STATUSES = new Set(['blocked', 'login_required', 'user_action_required']);
const TERMINAL_PLAN_STATUSES = new Set(['completed', 'failed', 'skipped']);
const ACTION_PLAN_STATUSES = new Set(['blocked', 'login_required', 'user_action_required']);

export const OBSERVATION_BATCH_RESULT_SCHEMA_VERSION = 'observation-batch-result/v1';

/**
 * In-process product boundary. It owns product snapshots and sequential plan
 * orchestration while delegating all runtime work to an injected PlanExecutor.
 */
export class MonitoringApplication {
  constructor({ repository, planExecutor = null, parserVersion = 'product-v1', runtimeVersion = 'local' }) {
    this.repository = repository;
    this.planExecutor = planExecutor;
    this.parserVersion = parserVersion;
    this.runtimeVersion = runtimeVersion;
  }

  createProject(input) {
    return this.repository.createMonitorProject({ ...input, project_id: input.project_id ?? newId('project') });
  }

  updateProject(projectId, changes) { return this.repository.updateMonitorProject(projectId, changes); }
  getProject(projectId) { return this.repository.getMonitorProject(projectId); }
  listProjects() { return this.repository.listMonitorProjects(); }

  createPromptSet(input) {
    return this.repository.createPromptSet({ ...input, prompt_set_id: input.prompt_set_id ?? newId('prompt_set') });
  }

  getPromptSet(promptSetId) { return this.repository.getPromptSet(promptSetId); }
  listPromptSets(projectId) { return this.repository.listPromptSets(projectId); }
  getOrCreateDefaultPromptSet(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`MonitorProject not found: ${projectId}`);
    return this.listPromptSets(projectId)[0] ?? this.createPromptSet({ project_id: projectId, name: '默认监测问题' });
  }
  addProjectPrompt(projectId, input) {
    const promptSet = this.getOrCreateDefaultPromptSet(projectId);
    const prompts = this.listPrompts(promptSet.prompt_set_id);
    return this.addPrompt({ ...input, prompt_set_id: promptSet.prompt_set_id, position: prompts.length });
  }
  addPrompt(input) {
    return this.repository.createPrompt({ ...input, prompt_id: input.prompt_id ?? newId('prompt') });
  }

  updatePrompt(promptId, changes) { return this.repository.updatePrompt(promptId, changes); }
  listPrompts(promptSetId, options) { return this.repository.listPrompts(promptSetId, options); }

  getProjectBatchPreview(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`MonitorProject not found: ${projectId}`);
    const promptSet = this.listPromptSets(projectId)[0] ?? null;
    const prompts = promptSet ? this.listPrompts(promptSet.prompt_set_id, { enabledOnly: true }) : [];
    const selectedPlatforms = Array.isArray(project.selected_platforms) ? project.selected_platforms : [];
    if (prompts.length === 0) return { can_run: false, message: '请先添加至少一个监测问题。' };
    if (selectedPlatforms.length === 0) return { can_run: false, message: '请至少选择一个 AI 平台。' };
    return {
      can_run: true,
      project_id: project.project_id,
      prompt_set_id: promptSet.prompt_set_id,
      monitoring_question_count: prompts.length,
      selected_platforms: selectedPlatforms,
      run_count: prompts.length * selectedPlatforms.length
    };
  }

  createBatch({ projectId, promptSetId, batchId = newId('batch'), parserVersion = this.parserVersion, runtimeVersion = this.runtimeVersion }) {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`MonitorProject not found: ${projectId}`);
    const promptSet = this.repository.getPromptSet(promptSetId);
    if (!promptSet || promptSet.project_id !== projectId) throw new Error('PromptSet must belong to the MonitorProject.');
    const prompts = this.repository.listPrompts(promptSetId, { enabledOnly: true });
    if (prompts.length === 0) throw new Error('A Batch requires at least one enabled Prompt.');
    const createdAt = new Date().toISOString();
    const snapshot = {
      project: {
        id: project.project_id,
        name: project.name,
        brand: { name: project.brand_name, aliases: project.brand_aliases },
        competitors: project.competitors
      },
      selected_platforms: project.selected_platforms,
      prompt_set: { id: promptSet.prompt_set_id, name: promptSet.name },
      prompts: prompts.map((prompt) => ({ id: prompt.prompt_id, label: prompt.label, text: prompt.text, order: prompt.position })),
      runtime: { parser_version: parserVersion, runtime: runtimeVersion },
      created_at: createdAt
    };
    return this.repository.createObservationBatchWithPlans({
      batch_id: batchId, project_id: projectId, prompt_set_id: promptSetId, status: 'ready', snapshot, created_at: createdAt
    });
  }

  getBatch(batchId) { return this.repository.getObservationBatch(batchId); }
  getBatchStatus(batchId) {
    const batch = this.getBatch(batchId);
    if (!batch) return null;
    return { batch_id: batch.batch_id, status: batch.status, started_at: batch.started_at, finished_at: batch.finished_at };
  }
  listBatchRunPlans(batchId) { return this.repository.listBatchRunPlans(batchId); }

  listProjectBatchHistory(projectId) {
    if (!this.getProject(projectId)) throw new Error(`MonitorProject not found: ${projectId}`);
    return this.repository.listObservationBatches(projectId).map((batch) => {
      const plans = this.listBatchRunPlans(batch.batch_id);
      return {
        batch_id: batch.batch_id,
        status: batch.status,
        created_at: batch.created_at,
        started_at: batch.started_at,
        finished_at: batch.finished_at,
        question_count: batch.snapshot.prompts.length,
        platform_count: batch.snapshot.selected_platforms.length,
        plan_count: plans.length,
        completed_plan_count: plans.filter((plan) => plan.status === 'completed').length,
        terminal_plan_count: plans.filter((plan) => TERMINAL_PLAN_STATUSES.has(plan.status)).length
      };
    });
  }

  getBatchResult(batchId) {
    const batch = this.getBatch(batchId);
    if (!batch) return null;
    const snapshot = batch.snapshot;
    const questionSnapshots = snapshot.prompts.map((prompt) => ({
      prompt_id: prompt.id,
      label: prompt.label ?? null,
      text: prompt.text,
      position: prompt.order
    }));
    const questionById = new Map(questionSnapshots.map((question) => [question.prompt_id, question]));
    const runs = this.listBatchRunPlans(batchId).map((plan) => {
      const observation = plan.run_id ? this.repository.getRunObservation(plan.run_id) : null;
      const run = observation?.run ?? null;
      const questionSnapshot = questionById.get(plan.prompt_id) ?? {
        prompt_id: plan.prompt_id,
        label: plan.prompt_label ?? null,
        text: plan.prompt_text,
        position: plan.prompt_position
      };
      return {
        plan_id: plan.plan_id,
        run_id: plan.run_id ?? null,
        platform_snapshot: plan.platform,
        question_snapshot: questionSnapshot,
        status: plan.status,
        created_at: plan.created_at,
        started_at: plan.started_at,
        finished_at: plan.finished_at,
        terminal: {
          status: plan.status,
          error: plan.error ?? null,
          action_required: ACTION_PLAN_STATUSES.has(plan.status) ? plan.status : null
        },
        run: run && {
          run_id: run.run_id,
          platform: run.platform,
          surface: run.surface,
          status: run.status,
          started_at: run.started_at,
          finished_at: run.finished_at,
          answer_status: run.answer_status,
          citation_status: run.citation_status,
          error: run.error ?? null
        },
        answer: observation?.answer ? {
          status: run.answer_status,
          text: observation.answer.answer_text,
          response_fingerprint: observation.answer.response_fingerprint
        } : null,
        citations: (observation?.citations ?? []).map((citation) => ({
          citation_id: citation.citation_id,
          run_id: citation.run_id,
          position: citation.position,
          title: citation.title,
          link_url: citation.link_url,
          display_domain: citation.display_domain,
          association_method: citation.association_method
        })),
        source_pool: run?.platform_reported_source_count === null || run?.platform_reported_source_count === undefined
          ? null
          : { reported_count: run.platform_reported_source_count },
        evidence: (observation?.artifacts ?? []).map((artifact) => ({
          artifact_id: artifact.artifact_id,
          run_id: artifact.run_id,
          kind: artifact.kind,
          created_at: artifact.created_at,
          reference: { type: 'local_artifact', artifact_id: artifact.artifact_id },
          local_path: artifact.path,
          availability: 'metadata_recorded'
        }))
      };
    });
    return {
      schema_version: OBSERVATION_BATCH_RESULT_SCHEMA_VERSION,
      batch: {
        batch_id: batch.batch_id,
        status: batch.status,
        created_at: batch.created_at,
        started_at: batch.started_at,
        finished_at: batch.finished_at,
        snapshot_version: batch.snapshot_version
      },
      project_snapshot: snapshot.project,
      question_snapshots: questionSnapshots,
      platform_snapshots: [...snapshot.selected_platforms],
      runs
    };
  }

  exportBatchResult(batchId) {
    const result = this.getBatchResult(batchId);
    if (!result) throw new Error(`ObservationBatch not found: ${batchId}`);
    return JSON.stringify(result, null, 2);
  }

  getArtifact(artifactId) { return this.repository.getArtifact(artifactId); }

  async startBatch(batchId) {
    const batch = this.#requireBatch(batchId);
    if (batch.status === 'blocked') throw new Error('Blocked Batch must be resumed, not started.');
    if (['completed', 'completed_with_failures'].includes(batch.status)) return batch;
    return this.#executePendingPlans(batchId);
  }

  async resumeBatch(batchId) {
    const batch = this.#requireBatch(batchId);
    if (batch.status !== 'blocked') throw new Error('Only a blocked Batch can be resumed.');
    const paused = this.listBatchRunPlans(batchId).find((plan) => PAUSED_PLAN_STATUSES.has(plan.status));
    if (!paused) throw new Error('Blocked Batch has no resumable plan.');
    this.repository.transitionBatchRunPlan(paused.plan_id, 'pending');
    return this.#executePendingPlans(batchId);
  }

  async #executePendingPlans(batchId) {
    if (!this.planExecutor || typeof this.planExecutor.execute !== 'function') {
      throw new Error('MonitoringApplication requires a PlanExecutor to start a Batch.');
    }
    const batch = this.#requireBatch(batchId);
    const snapshot = batch.snapshot;
    for (const plan of this.listBatchRunPlans(batchId)) {
      if (plan.status !== 'pending') continue;
      this.repository.transitionBatchRunPlan(plan.plan_id, 'running');
      this.repository.aggregateObservationBatch(batchId);
      let outcome;
      try {
        outcome = assertPlanExecutionOutcome(await this.planExecutor.execute(plan, snapshot));
        if (outcome.run_id) this.repository.attachRunToBatchRunPlan(plan.plan_id, outcome.run_id);
        this.repository.transitionBatchRunPlan(plan.plan_id, outcome.status, { error: outcome.error ?? null });
      } catch (cause) {
        // An Application/boundary exception is recoverable: preserve prior work,
        // leave this plan visibly blocked, and never pretend it completed.
        this.repository.transitionBatchRunPlan(plan.plan_id, 'blocked', { error: `Application execution error: ${cause.message}` });
        this.repository.aggregateObservationBatch(batchId);
        throw new Error(`Batch ${batchId} interrupted by an Application execution error.`, { cause });
      }
      const updated = this.repository.aggregateObservationBatch(batchId);
      if (PAUSED_PLAN_STATUSES.has(outcome.status)) return updated;
    }
    return this.#requireBatch(batchId);
  }

  #requireBatch(batchId) {
    const batch = this.getBatch(batchId);
    if (!batch) throw new Error(`ObservationBatch not found: ${batchId}`);
    return batch;
  }
}

export const PLAN_STATUS_CLASSIFICATION = Object.freeze({
  terminal: [...TERMINAL_PLAN_STATUSES], resumable: [...PAUSED_PLAN_STATUSES], active: ['pending', 'running']
});
