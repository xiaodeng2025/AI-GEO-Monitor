import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { newId } from './hash.js';

function isBytes(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

/** Writes and indexes only already-materialized, runtime-neutral evidence. */
export class ArtifactStore {
  constructor({ rootDir, projectDir = process.cwd() }) {
    this.rootDir = rootDir;
    this.projectDir = projectDir;
  }

  async #runDir(runId) {
    const directory = resolve(this.rootDir, runId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  #record(runId, kind, absolutePath) {
    return {
      artifact_id: newId('artifact'),
      run_id: runId,
      kind,
      path: relative(this.projectDir, absolutePath),
      created_at: new Date().toISOString()
    };
  }

  #resolveFile(directory, fileName) {
    if (typeof fileName !== 'string' || !fileName || isAbsolute(fileName)) {
      throw new TypeError('Materialized artifact fileName must be a relative non-empty string.');
    }
    const absolutePath = resolve(directory, fileName);
    const pathFromDirectory = relative(directory, absolutePath);
    if (!pathFromDirectory || pathFromDirectory.startsWith('..') || isAbsolute(pathFromDirectory)) {
      throw new TypeError('Materialized artifact fileName must remain inside the run artifact directory.');
    }
    return absolutePath;
  }

  /**
   * Persists plain strings/bytes. The payload must not contain a Page, Locator,
   * DOM reference, or any other runtime handle.
   */
  async persistMaterialized(runId, payloads = []) {
    const directory = await this.#runDir(runId);
    const artifacts = [];
    for (const payload of payloads) {
      if (!payload || typeof payload.kind !== 'string' || !payload.kind) {
        throw new TypeError('Materialized artifact kind is required.');
      }
      if (!isBytes(payload.content) && typeof payload.content !== 'string') {
        throw new TypeError('Materialized artifact content must be a string or bytes.');
      }
      const filePath = this.#resolveFile(directory, payload.fileName);
      await writeFile(filePath, payload.content);
      artifacts.push(this.#record(runId, payload.kind, filePath));
    }
    return artifacts;
  }

  /** Error detail is plain evidence; runtime failure screenshots are supplied separately. */
  async saveFailure(runId, error) {
    return this.persistMaterialized(runId, [{
      kind: 'error_detail',
      fileName: 'error.txt',
      content: `${error.name}: ${error.message}\n`
    }]);
  }
}
