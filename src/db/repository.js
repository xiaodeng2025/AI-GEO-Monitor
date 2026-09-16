import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

const SUPPORTED_PLATFORMS = new Set(['kimi', 'yuanbao', 'deepseek']);
// SQLite keeps legacy draft/failed values accepted for migration compatibility,
// but Product code emits only these current lifecycle states.
const BATCH_STATUSES = new Set(['ready', 'running', 'completed', 'completed_with_failures', 'blocked']);
const PLAN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'blocked', 'login_required', 'user_action_required', 'skipped']);
const PLAN_TRANSITIONS = {
  pending: new Set(['running', 'blocked', 'login_required', 'user_action_required', 'skipped', 'failed']),
  running: new Set(['completed', 'failed', 'blocked', 'login_required', 'user_action_required', 'skipped']),
  blocked: new Set(['pending', 'skipped']),
  login_required: new Set(['pending', 'skipped']),
  user_action_required: new Set(['pending', 'skipped']),
  completed: new Set(), failed: new Set(), skipped: new Set()
};
const BATCH_TRANSITIONS = {
  ready: new Set(['running', 'blocked']),
  running: new Set(['completed', 'completed_with_failures', 'blocked']),
  blocked: new Set(['ready', 'running']),
  completed: new Set(), completed_with_failures: new Set()
};

export const PRODUCT_PLAN_STATUSES = Object.freeze([...PLAN_STATUSES]);
export const PRODUCT_BATCH_STATUSES = Object.freeze([...BATCH_STATUSES]);

function json(value, field) {
  if (value === undefined) throw new Error(`${field} is required.`);
  return JSON.stringify(value);
}

function parseJson(value, field) {
  try { return JSON.parse(value); } catch { throw new Error(`Stored ${field} is invalid JSON.`); }
}

function requirePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((platform) => !SUPPORTED_PLATFORMS.has(platform))) {
    throw new Error('selected_platforms must be a non-empty array of kimi, yuanbao, and/or deepseek.');
  }
  if (new Set(platforms).size !== platforms.length) throw new Error('selected_platforms must not contain duplicates.');
}

function now(value) { return value ?? new Date().toISOString(); }

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  const columns = db.prepare('PRAGMA table_info(run)').all();
  if (!columns.some((column) => column.name === 'platform_reported_source_count')) {
    db.exec('ALTER TABLE run ADD COLUMN platform_reported_source_count INTEGER CHECK (platform_reported_source_count IS NULL OR platform_reported_source_count >= 0)');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(SCHEMA_VERSION, new Date().toISOString());
  return db;
}

export class GeoRepository {
  constructor(db) { this.db = db; }

  upsertCapability(capability) {
    this.db.prepare(`INSERT INTO platform_capability
      (platform, surface, answer, citation_capture, citation_title, citation_url, citation_domain, citation_position, updated_at)
      VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, surface) DO UPDATE SET
        answer=excluded.answer, citation_capture=excluded.citation_capture,
        citation_title=excluded.citation_title, citation_url=excluded.citation_url,
        citation_domain=excluded.citation_domain, citation_position=excluded.citation_position,
        updated_at=excluded.updated_at`).run(
      capability.platform, Number(capability.answer), capability.citation_capture,
      Number(capability.citation_title), Number(capability.citation_url),
      Number(capability.citation_domain), Number(capability.citation_position), new Date().toISOString()
    );
  }

  createRun(run) {
    this.db.prepare(`INSERT INTO run
      (run_id, prompt_id, prompt_text, platform, surface, started_at, finished_at, status, answer_status, citation_status, parser_version, error, platform_reported_source_count)
      VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.run_id, run.prompt_id, run.prompt_text, run.platform, run.started_at,
      run.finished_at ?? null, run.status, run.answer_status, run.citation_status,
      run.parser_version, run.error ?? null, run.platform_reported_source_count ?? null
    );
  }

  finishRun(run) {
    this.db.prepare(`UPDATE run SET
      finished_at = ?, status = ?, answer_status = ?, citation_status = ?, error = ?, platform_reported_source_count = ?
      WHERE run_id = ?`).run(
      run.finished_at, run.status, run.answer_status, run.citation_status,
      run.error ?? null, run.platform_reported_source_count ?? null, run.run_id
    );
  }

  saveAnswer(answer) {
    this.db.prepare(`INSERT INTO answer
      (run_id, answer_text, answer_html_fragment, response_fingerprint, brand_hits, competitor_hits)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      answer.run_id, answer.answer_text, answer.answer_html_fragment, answer.response_fingerprint,
      JSON.stringify(answer.brand_hits), JSON.stringify(answer.competitor_hits)
    );
  }

  saveCitation(citation) {
    this.db.prepare(`INSERT INTO citation
      (citation_id, run_id, position, title, link_url, display_domain, association_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      citation.citation_id, citation.run_id, citation.position ?? null, citation.title ?? null,
      citation.link_url ?? null, citation.display_domain ?? null, citation.association_method
    );
  }

  saveArtifact(artifact) {
    this.db.prepare('INSERT INTO artifact (artifact_id, run_id, kind, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(artifact.artifact_id, artifact.run_id, artifact.kind, artifact.path, artifact.created_at);
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId);
  }

  getRunObservation(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    return {
      run,
      answer: this.db.prepare('SELECT * FROM answer WHERE run_id = ?').get(runId) ?? null,
      citations: this.db.prepare(`SELECT * FROM citation WHERE run_id = ?
        ORDER BY position IS NULL, position, citation_id`).all(runId),
      artifacts: this.db.prepare('SELECT * FROM artifact WHERE run_id = ? ORDER BY created_at, artifact_id').all(runId)
    };
  }

  getArtifact(artifactId) {
    return this.db.prepare('SELECT * FROM artifact WHERE artifact_id = ?').get(artifactId) ?? null;
  }

  createMonitorProject(project) {
    requirePlatforms(project.selected_platforms);
    const timestamp = now(project.created_at);
    this.db.prepare(`INSERT INTO monitor_project
      (project_id, name, brand_name, brand_aliases, competitors, selected_platforms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(project.project_id, project.name, project.brand_name, json(project.brand_aliases ?? [], 'brand_aliases'),
        json(project.competitors ?? [], 'competitors'), json(project.selected_platforms, 'selected_platforms'), timestamp, now(project.updated_at ?? timestamp));
    return this.getMonitorProject(project.project_id);
  }

  getMonitorProject(projectId) {
    const row = this.db.prepare('SELECT * FROM monitor_project WHERE project_id = ?').get(projectId);
    return row && this.#project(row);
  }

  listMonitorProjects() {
    return this.db.prepare('SELECT * FROM monitor_project ORDER BY created_at, project_id').all().map((row) => this.#project(row));
  }

  updateMonitorProject(projectId, changes) {
    const existing = this.getMonitorProject(projectId);
    if (!existing) throw new Error(`MonitorProject not found: ${projectId}`);
    const next = { ...existing, ...changes };
    requirePlatforms(next.selected_platforms);
    this.db.prepare(`UPDATE monitor_project SET name = ?, brand_name = ?, brand_aliases = ?, competitors = ?, selected_platforms = ?, updated_at = ? WHERE project_id = ?`)
      .run(next.name, next.brand_name, json(next.brand_aliases, 'brand_aliases'), json(next.competitors, 'competitors'), json(next.selected_platforms, 'selected_platforms'), now(changes.updated_at), projectId);
    return this.getMonitorProject(projectId);
  }

  createPromptSet(promptSet) {
    const timestamp = now(promptSet.created_at);
    this.db.prepare('INSERT INTO prompt_set (prompt_set_id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(promptSet.prompt_set_id, promptSet.project_id, promptSet.name, timestamp, now(promptSet.updated_at ?? timestamp));
    return this.getPromptSet(promptSet.prompt_set_id);
  }

  getPromptSet(promptSetId) {
    return this.db.prepare('SELECT * FROM prompt_set WHERE prompt_set_id = ?').get(promptSetId) ?? null;
  }

  listPromptSets(projectId) {
    return this.db.prepare('SELECT * FROM prompt_set WHERE project_id = ? ORDER BY created_at, prompt_set_id').all(projectId);
  }

  createPrompt(prompt) {
    const timestamp = now(prompt.created_at);
    this.db.prepare(`INSERT INTO prompt (prompt_id, prompt_set_id, label, text, position, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(prompt.prompt_id, prompt.prompt_set_id, prompt.label ?? null, prompt.text,
      prompt.position, Number(prompt.enabled ?? true), timestamp, now(prompt.updated_at ?? timestamp));
    return this.getPrompt(prompt.prompt_id);
  }

  getPrompt(promptId) {
    return this.db.prepare('SELECT * FROM prompt WHERE prompt_id = ?').get(promptId) ?? null;
  }

  listPrompts(promptSetId, { enabledOnly = false } = {}) {
    return this.db.prepare(`SELECT * FROM prompt WHERE prompt_set_id = ? ${enabledOnly ? 'AND enabled = 1' : ''} ORDER BY position, prompt_id`).all(promptSetId);
  }

  updatePrompt(promptId, changes) {
    const existing = this.getPrompt(promptId);
    if (!existing) throw new Error(`Prompt not found: ${promptId}`);
    const next = { ...existing, ...changes };
    this.db.prepare('UPDATE prompt SET label = ?, text = ?, position = ?, enabled = ?, updated_at = ? WHERE prompt_id = ?')
      .run(next.label ?? null, next.text, next.position, Number(next.enabled), now(changes.updated_at), promptId);
    return this.getPrompt(promptId);
  }

  createObservationBatch(batch) {
    if (!BATCH_STATUSES.has(batch.status ?? 'ready')) throw new Error('Unsupported ObservationBatch status.');
    const timestamp = now(batch.created_at);
    this.db.prepare(`INSERT INTO observation_batch
      (batch_id, project_id, prompt_set_id, status, snapshot_version, snapshot_json, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(batch.batch_id, batch.project_id, batch.prompt_set_id ?? null,
      batch.status ?? 'ready', batch.snapshot_version ?? 1, json(batch.snapshot, 'snapshot'), timestamp,
      batch.started_at ?? null, batch.finished_at ?? null);
    return this.getObservationBatch(batch.batch_id);
  }

  getObservationBatch(batchId) {
    const row = this.db.prepare('SELECT * FROM observation_batch WHERE batch_id = ?').get(batchId);
    return row && this.#batch(row);
  }

  listObservationBatches(projectId) {
    return this.db.prepare('SELECT * FROM observation_batch WHERE project_id = ? ORDER BY created_at DESC, batch_id DESC')
      .all(projectId).map((row) => this.#batch(row));
  }

  generateBatchRunPlans(batchId, { created_at } = {}) {
    const batch = this.getObservationBatch(batchId);
    if (!batch) throw new Error(`ObservationBatch not found: ${batchId}`);
    const existing = this.listBatchRunPlans(batchId);
    if (existing.length > 0) throw new Error(`BatchRunPlans already exist for ${batchId}.`);
    this.db.exec('BEGIN');
    try {
      const plans = this.#insertBatchRunPlans(batch, created_at);
      this.db.exec('COMMIT');
      return plans;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createObservationBatchWithPlans(batch, { created_at } = {}) {
    this.db.exec('BEGIN');
    try {
      const created = this.createObservationBatch(batch);
      const plans = this.#insertBatchRunPlans(created, created_at ?? batch.created_at);
      this.db.exec('COMMIT');
      return { batch: this.getObservationBatch(created.batch_id), plans };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #insertBatchRunPlans(batch, createdAt) {
    const snapshot = batch.snapshot;
    requirePlatforms(snapshot.selected_platforms);
    if (!Array.isArray(snapshot.prompts) || snapshot.prompts.length === 0) throw new Error('Batch snapshot must contain prompts.');
    const prompts = [...snapshot.prompts].sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
    const timestamp = now(createdAt);
    let planPosition = 0;
    const insert = this.db.prepare(`INSERT INTO batch_run_plan
      (plan_id, batch_id, prompt_id, prompt_text, prompt_label, prompt_position, platform, plan_position, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
    for (const prompt of prompts) {
      for (const platform of snapshot.selected_platforms) {
        insert.run(`${batch.batch_id}:plan:${planPosition}`, batch.batch_id, prompt.id, prompt.text, prompt.label ?? null,
          prompt.order, platform, planPosition, timestamp);
        planPosition += 1;
      }
    }
    return this.listBatchRunPlans(batch.batch_id);
  }

  listBatchRunPlans(batchId) {
    return this.db.prepare('SELECT * FROM batch_run_plan WHERE batch_id = ? ORDER BY plan_position, plan_id').all(batchId);
  }

  attachRunToBatchRunPlan(planId, runId) {
    const plan = this.#plan(planId);
    if (!plan) throw new Error(`BatchRunPlan not found: ${planId}`);
    if (plan.run_id) throw new Error(`BatchRunPlan already has a Run: ${planId}`);
    if (!this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
    this.db.prepare('UPDATE batch_run_plan SET run_id = ? WHERE plan_id = ?').run(runId, planId);
    return this.#plan(planId);
  }

  transitionBatchRunPlan(planId, status, { error = null, at } = {}) {
    if (!PLAN_STATUSES.has(status)) throw new Error('Unsupported BatchRunPlan status.');
    const plan = this.#plan(planId);
    if (!plan) throw new Error(`BatchRunPlan not found: ${planId}`);
    if (!PLAN_TRANSITIONS[plan.status].has(status)) throw new Error(`Invalid BatchRunPlan transition: ${plan.status} -> ${status}`);
    const timestamp = now(at);
    const startedAt = status === 'running' && !plan.started_at ? timestamp : plan.started_at;
    const terminal = ['completed', 'failed', 'skipped'].includes(status);
    this.db.prepare('UPDATE batch_run_plan SET status = ?, error = ?, started_at = ?, finished_at = ? WHERE plan_id = ?')
      .run(status, error, startedAt, terminal ? timestamp : null, planId);
    return this.#plan(planId);
  }

  aggregateObservationBatch(batchId, { at } = {}) {
    const batch = this.getObservationBatch(batchId);
    if (!batch) throw new Error(`ObservationBatch not found: ${batchId}`);
    const plans = this.listBatchRunPlans(batchId);
    const status = this.#aggregateStatus(batch, plans);
    if (status === batch.status) return batch;
    if (!BATCH_TRANSITIONS[batch.status].has(status)) throw new Error(`Invalid ObservationBatch transition: ${batch.status} -> ${status}`);
    const timestamp = now(at);
    const startedAt = status === 'running' && !batch.started_at ? timestamp : batch.started_at;
    const terminal = ['completed', 'completed_with_failures'].includes(status);
    this.db.prepare('UPDATE observation_batch SET status = ?, started_at = ?, finished_at = ? WHERE batch_id = ?')
      .run(status, startedAt, terminal ? timestamp : null, batchId);
    return this.getObservationBatch(batchId);
  }

  #aggregateStatus(batch, plans) {
    if (plans.some((plan) => plan.status === 'running')) return 'running';
    if (plans.some((plan) => ['blocked', 'login_required', 'user_action_required'].includes(plan.status))) return 'blocked';
    if (plans.length === 0 || plans.some((plan) => plan.status === 'pending')) return batch.started_at ? 'running' : 'ready';
    if (plans.every((plan) => plan.status === 'completed')) return 'completed';
    return 'completed_with_failures';
  }

  #project(row) {
    return { ...row, brand_aliases: parseJson(row.brand_aliases, 'brand_aliases'), competitors: parseJson(row.competitors, 'competitors'), selected_platforms: parseJson(row.selected_platforms, 'selected_platforms') };
  }

  #batch(row) { return { ...row, snapshot: parseJson(row.snapshot_json, 'snapshot_json') }; }
  #plan(planId) { return this.db.prepare('SELECT * FROM batch_run_plan WHERE plan_id = ?').get(planId) ?? null; }
}
