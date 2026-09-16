import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, GeoRepository } from '../src/db/repository.js';

test('SQLite repository persists a run and declared capability', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-'));
  try {
    const db = openDatabase(join(directory, 'monitor.sqlite'));
    const repo = new GeoRepository(db);
    repo.upsertCapability({ platform: 'Kimi Web', answer: true, citation_capture: 'trigger_bound', citation_title: true, citation_url: true, citation_domain: true, citation_position: true });
    repo.createRun({ run_id: 'run-1', prompt_id: 'p-1', prompt_text: 'test', platform: 'Kimi Web', started_at: '2026-09-02T00:00:00.000Z', status: 'completed', answer_status: 'captured', citation_status: 'not_displayed', parser_version: 'test' });
    assert.equal(repo.getRun('run-1').prompt_text, 'test');
    assert.equal(db.prepare('SELECT citation_capture FROM platform_capability WHERE platform = ?').get('Kimi Web').citation_capture, 'trigger_bound');
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
