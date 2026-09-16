import { executeRuntimeNeutralMonitoredRun } from '../core/monitored-run.js';
import { PlatformRuntimeFactory } from './platform-runtime-factory.js';

function productPrompt(plan) {
  return { id: plan.prompt_id, label: plan.prompt_label, text: plan.prompt_text };
}

function productPromptSet(snapshot) {
  return {
    brand: snapshot.project?.brand ?? { name: '', aliases: [] },
    competitors: snapshot.project?.competitors ?? []
  };
}

function errorText(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}

/** In-process bridge from product plans to the existing monitored-run path. */
export class ProductionPlanExecutor {
  constructor({ runtimeFactory = null, repository = null, artifactStore = undefined, profilesRoot = undefined, onTerminalPersisted = null } = {}) {
    this.runtimeFactory = runtimeFactory ?? new PlatformRuntimeFactory({ repository, artifactStore, ...(profilesRoot ? { profilesRoot } : {}) });
    this.onTerminalPersisted = onTerminalPersisted;
  }

  async execute(plan, batchSnapshot) {
    let runtime;
    try {
      runtime = this.runtimeFactory.create(plan.platform);
    } catch (error) {
      return { status: 'failed', error: errorText(error) };
    }

    const prompt = productPrompt(plan);
    const promptSet = productPromptSet(batchSnapshot);
    try {
      const result = await executeRuntimeNeutralMonitoredRun({
        service: runtime.service,
        platform: runtime.capability.platform,
        capability: runtime.capability,
        prompt,
        promptSet,
        sessionRunner: (input) => runtime.session.run(input),
        closeSession: runtime.closeSession,
        onTerminalPersisted: this.onTerminalPersisted
          ? async (terminal, metadata) => this.onTerminalPersisted({
            platform: plan.platform,
            plan_id: plan.plan_id,
            run_id: terminal.runId,
            status: metadata.error?.code === 'MANUAL_LOGIN_REQUIRED'
              ? 'login_required'
              : metadata.error
                ? 'failed'
                : 'completed',
            terminal,
            error: metadata.error ?? null
          })
          : null
      });
      return { status: 'completed', run_id: result.runId };
    } catch (error) {
      const status = error?.code === 'MANUAL_LOGIN_REQUIRED' ? 'login_required' : 'failed';
      return { status, ...(error?.runId ? { run_id: error.runId } : {}), error: errorText(error) };
    }
  }
}
