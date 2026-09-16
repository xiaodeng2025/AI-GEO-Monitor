/**
 * Keeps one local Product Runtime execution in-process without turning the
 * loopback transport into a worker, queue, or public job system.
 */
export function createLocalBatchCoordinator({ app }) {
  let activeBatchId = null;
  const executions = new Map();

  function conflict(batchId) {
    const error = new Error('已有本次监测正在运行，请等待其完成后再启动新的监测。');
    error.status = 409;
    error.batchId = batchId;
    return error;
  }

  function launch(batchId, execute) {
    if (activeBatchId && activeBatchId !== batchId) throw conflict(activeBatchId);
    if (executions.has(batchId)) return;
    activeBatchId = batchId;
    const execution = Promise.resolve()
      .then(execute)
      // MonitoringApplication already persists an unexpected boundary failure
      // as a blocked plan before rejecting. Keep the process alive for polling.
      .catch(() => undefined)
      .finally(() => {
        executions.delete(batchId);
        if (activeBatchId === batchId) activeBatchId = null;
      });
    executions.set(batchId, execution);
  }

  return {
    createAndStart(projectId) {
      if (activeBatchId) throw conflict(activeBatchId);
      const preview = app.getProjectBatchPreview(projectId);
      if (!preview.can_run) throw new Error(preview.message);
      const created = app.createBatch({ projectId, promptSetId: preview.prompt_set_id });
      launch(created.batch.batch_id, () => app.startBatch(created.batch.batch_id));
      return { batch: app.getBatchStatus(created.batch.batch_id), plan_count: created.plans.length };
    },

    resume(batchId) {
      if (activeBatchId && activeBatchId !== batchId) throw conflict(activeBatchId);
      launch(batchId, () => app.resumeBatch(batchId));
      return app.getBatchStatus(batchId);
    },

    activeBatchId() { return activeBatchId; }
  };
}
