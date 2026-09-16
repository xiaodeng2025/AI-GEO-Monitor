export const PLAN_EXECUTION_OUTCOMES = Object.freeze([
  'completed', 'failed', 'blocked', 'login_required', 'user_action_required', 'skipped'
]);

/**
 * Runtime-neutral product execution boundary. Implementations create any Core
 * Run they need, then return only its id and a product outcome to Application.
 */
export function assertPlanExecutionOutcome(outcome) {
  if (!outcome || !PLAN_EXECUTION_OUTCOMES.includes(outcome.status)) {
    throw new Error('PlanExecutor returned an unsupported outcome status.');
  }
  if (outcome.status === 'completed' && !outcome.run_id) {
    throw new Error('A completed PlanExecutor outcome requires an existing run_id.');
  }
  return outcome;
}
