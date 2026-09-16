export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  run_id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  platform TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface = 'web'),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  answer_status TEXT NOT NULL CHECK (answer_status IN ('captured', 'timeout', 'failed')),
  citation_status TEXT NOT NULL CHECK (citation_status IN ('captured', 'not_displayed', 'unsupported', 'parse_failed', 'unattributed')),
  parser_version TEXT NOT NULL,
  error TEXT,
  platform_reported_source_count INTEGER CHECK (platform_reported_source_count IS NULL OR platform_reported_source_count >= 0)
);

CREATE TABLE IF NOT EXISTS answer (
  run_id TEXT PRIMARY KEY REFERENCES run(run_id) ON DELETE CASCADE,
  answer_text TEXT NOT NULL,
  answer_html_fragment TEXT NOT NULL,
  response_fingerprint TEXT NOT NULL,
  brand_hits TEXT NOT NULL,
  competitor_hits TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citation (
  citation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  position INTEGER,
  title TEXT,
  link_url TEXT,
  display_domain TEXT,
  association_method TEXT NOT NULL CHECK (association_method IN ('contained', 'trigger_bound'))
);

CREATE TABLE IF NOT EXISTS artifact (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_capability (
  platform TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface = 'web'),
  answer INTEGER NOT NULL,
  citation_capture TEXT NOT NULL CHECK (citation_capture IN ('contained', 'trigger_bound', 'not_exposed', 'unsupported')),
  citation_title INTEGER NOT NULL,
  citation_url INTEGER NOT NULL,
  citation_domain INTEGER NOT NULL,
  citation_position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, surface)
);

CREATE TABLE IF NOT EXISTS monitor_project (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  brand_aliases TEXT NOT NULL,
  competitors TEXT NOT NULL,
  selected_platforms TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_set (
  prompt_set_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES monitor_project(project_id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt (
  prompt_id TEXT PRIMARY KEY,
  prompt_set_id TEXT NOT NULL REFERENCES prompt_set(prompt_set_id) ON DELETE RESTRICT,
  label TEXT,
  text TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (prompt_set_id, position)
);

CREATE TABLE IF NOT EXISTS observation_batch (
  batch_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES monitor_project(project_id) ON DELETE RESTRICT,
  prompt_set_id TEXT REFERENCES prompt_set(prompt_set_id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'running', 'completed', 'completed_with_failures', 'blocked', 'failed')),
  snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_version = 1),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS batch_run_plan (
  plan_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES observation_batch(batch_id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  prompt_label TEXT,
  prompt_position INTEGER NOT NULL CHECK (prompt_position >= 0),
  platform TEXT NOT NULL CHECK (platform IN ('kimi', 'yuanbao', 'deepseek')),
  plan_position INTEGER NOT NULL CHECK (plan_position >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'blocked', 'login_required', 'user_action_required', 'skipped')),
  run_id TEXT REFERENCES run(run_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  UNIQUE (batch_id, plan_position),
  UNIQUE (batch_id, prompt_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_prompt_set_project ON prompt_set(project_id);
CREATE INDEX IF NOT EXISTS idx_prompt_prompt_set ON prompt(prompt_set_id, position);
CREATE INDEX IF NOT EXISTS idx_batch_project ON observation_batch(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_batch ON batch_run_plan(batch_id, plan_position);
CREATE INDEX IF NOT EXISTS idx_plan_run ON batch_run_plan(run_id);
`;
