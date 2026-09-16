import { captureDeepSeekDeadSnapshot } from './deepseek-dead-snapshot.js';
import { captureDoubaoDeadSnapshot } from './doubao-dead-snapshot.js';
import { captureYuanbaoSnapshot } from './yuanbao-snapshot.js';
import { captureWenxinSnapshot } from './wenxin-snapshot.js';

const SNAPSHOT_HANDLERS = Object.freeze({
  deepseek: ({ page, preparation }) => captureDeepSeekDeadSnapshot({ page, preparation }),
  doubao: ({ page }) => captureDoubaoDeadSnapshot({ page }),
  yuanbao: ({ page, artifactDir, fileName }) => captureYuanbaoSnapshot({ page, artifactDir, fileName }),
  wenxin: ({ page, artifactDir, fileName }) => captureWenxinSnapshot({ page, artifactDir, fileName })
});

const failure = (error) => ({
  status: 'failed',
  artifact_reference: null,
  bytes: null,
  captured_at: null,
  error: error instanceof Error ? error.message : String(error)
});

function artifactMetadata(nativeResult) {
  const artifact = nativeResult.artifact ?? nativeResult.artifacts?.[0] ?? null;
  const content = artifact?.content;
  return {
    artifact_reference: artifact?.path ?? artifact?.fileName ?? null,
    bytes: artifact?.bytes ?? (typeof content === 'string' ? Buffer.byteLength(content) : content?.byteLength ?? null)
  };
}

function normalizeSnapshotResult(nativeResult, capturedAt) {
  if (!nativeResult || nativeResult.status !== 'captured') {
    return failure(nativeResult?.error ?? `Snapshot did not capture: ${nativeResult?.status ?? 'no result'}`);
  }
  return {
    status: 'captured',
    ...artifactMetadata(nativeResult),
    captured_at: nativeResult.captured_at ?? capturedAt,
    error: null
  };
}

/**
 * Selects a platform-owned Snapshot implementation without sharing page logic.
 */
export function createSnapshotDispatcher({ handlers = SNAPSHOT_HANDLERS, now = () => new Date().toISOString() } = {}) {
  const captureWithArtifacts = async ({ platform, context = {} }) => {
    const handler = handlers[platform];
    if (typeof handler !== 'function') throw new Error(`Unsupported snapshot platform: ${platform}`);
    try {
      const nativeResult = await handler(context);
      return {
        snapshot_result: normalizeSnapshotResult(nativeResult, now()),
        artifacts: nativeResult?.artifacts ?? []
      };
    } catch (error) {
      return { snapshot_result: failure(error), artifacts: [] };
    }
  };
  return Object.freeze({
    captureWithArtifacts,
    async capture(input) { return (await captureWithArtifacts(input)).snapshot_result; }
  });
}

export const snapshotDispatcher = createSnapshotDispatcher();

/**
 * Records Snapshot outcome beside, never inside, an already-completed acquisition.
 */
export async function captureSnapshotIsolated({ acquisitionResult, dispatcher = snapshotDispatcher, platform, context }) {
  return {
    acquisition_result: acquisitionResult,
    snapshot_result: await dispatcher.capture({ platform, context })
  };
}
