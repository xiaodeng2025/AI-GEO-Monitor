import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/core/artifact-store.js';

test('ArtifactStore persists only plain materialized strings and bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-geo-monitor-artifact-'));
  try {
    const store = new ArtifactStore({ rootDir: directory, projectDir: directory });
    const artifacts = await store.persistMaterialized('run-plain', [
      { kind: 'answer_html', fileName: 'answer.html', content: '<p>answer</p>' },
      { kind: 'answer_screenshot', fileName: 'answer.png', content: Buffer.from('png-bytes') }
    ]);
    assert.deepEqual(artifacts.map(({ kind, path }) => ({ kind, path })), [
      { kind: 'answer_html', path: 'run-plain\\answer.html' },
      { kind: 'answer_screenshot', path: 'run-plain\\answer.png' }
    ]);
    assert.equal(readFileSync(join(directory, 'run-plain', 'answer.html'), 'utf8'), '<p>answer</p>');
    assert.equal(readFileSync(join(directory, 'run-plain', 'answer.png'), 'utf8'), 'png-bytes');
    assert.equal(typeof store.saveResponse, 'undefined');
    assert.equal(typeof store.saveCitations, 'undefined');
    await assert.rejects(
      store.persistMaterialized('run-invalid', [{ kind: 'bad', fileName: 'bad.bin', content: { screenshot() {} } }]),
      /content must be a string or bytes/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
