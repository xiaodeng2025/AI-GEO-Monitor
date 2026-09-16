/**
 * Owns durable lifecycle around a Runtime Session that returns only plain
 * evidence. The session owns browser/page cleanup; Core never receives a page.
 */
export async function executeRuntimeNeutralMonitoredRun({
  service, platform, capability, prompt, promptSet, sessionRunner,
  closeSession,
  onTerminalPersisted = null
}) {
  const lifecycle = service.beginRun({ prompt, platform, capability });
  let terminalOutcome = null;
  let terminalNotified = false;

  async function notifyTerminalOutcome(outcome, metadata = {}) {
    if (onTerminalPersisted && !terminalNotified) {
      terminalNotified = true;
      await onTerminalPersisted(outcome, metadata);
    }
  }

  try {
    terminalOutcome = await service.executeRuntimeNeutral({ prompt, promptSet, lifecycle, sessionRunner });
    await notifyTerminalOutcome(terminalOutcome, { error: null });
    return terminalOutcome;
  } catch (error) {
    if (!error.runId) {
      const terminal = await service.failStartedRun({
        lifecycle,
        error,
        failureArtifacts: Array.isArray(error.failureArtifacts) ? error.failureArtifacts : []
      });
      Object.assign(error, { runId: lifecycle.runId, ...terminal });
    }
    terminalOutcome = {
      runId: error.runId,
      answerStatus: error.answerStatus,
      citationStatus: error.citationStatus,
      citations: 0
    };
    await notifyTerminalOutcome(terminalOutcome, { error });
    throw error;
  } finally {
    await closeSession();
  }
}
