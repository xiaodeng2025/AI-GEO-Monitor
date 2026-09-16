import { resolve } from 'node:path';
import { openDatabase } from './db/repository.js';

const [command, ...argumentsList] = process.argv.slice(2);
if (command === 'db:init') {
  const dbPath = resolve('data', 'geo-monitor.sqlite');
  const db = openDatabase(dbPath);
  db.close();
  console.log(`SQLite schema initialized: ${dbPath}`);
} else if (command === 'db:show') {
  const runId = argumentsList[0];
  if (!runId) throw new Error('Usage: npm run db:show -- <run-id>');
  const db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
  const run = db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const answer = db.prepare('SELECT * FROM answer WHERE run_id = ?').get(runId) ?? null;
  const citations = db.prepare('SELECT * FROM citation WHERE run_id = ? ORDER BY position, citation_id').all(runId);
  const artifacts = db.prepare('SELECT * FROM artifact WHERE run_id = ? ORDER BY created_at').all(runId);
  console.log(JSON.stringify({ run, answer, citations, artifacts }, null, 2));
  db.close();
} else {
  console.error('Usage: npm run db:init | npm run db:show -- <run-id>');
  process.exitCode = 1;
}
