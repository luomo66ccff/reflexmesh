import { TEARDOWN_FAILURES } from './deepseek-teardown-contract.mjs';

// Installed Loader + native Agent result with deliberately stalled shadow storage.
export const FENCE_ASSERTIONS = Object.freeze([
  'isolated_cli_profile_and_loader',
  'native_tool_result_delivered',
  'admission_recorded_before_unload',
  'after_pending_at_unload',
  'fenced_unload_completed',
  'late_storage_write_rejected',
  'missing_shadow_outcome_retained',
  'agent_received_result_without_retry',
  'zero_labels_and_no_remote_model',
  'natural_host_exit',
]);
export const FENCE_FAILURES = TEARDOWN_FAILURES;
export const FENCE_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_observer_fence', agentE2E: false,
  modelInference: false, modelTransport: 'synthetic_adapter', classification: 'abstain',
});

export function evaluateFenceProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(FENCE_EVIDENCE).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_observer_fence_passed'
    && version === '0.1.2-rc.1' && value.agentLoopExercised === true
    && value.assertions.length === FENCE_ASSERTIONS.length
    && FENCE_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: FENCE_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && FENCE_FAILURES.includes(value.reason)
    && value.agentLoopExercised === false) {
    return { status: 'failed', reason: value.reason, version,
      assertions: FENCE_ASSERTIONS.map(name => ({ name, passed: false })) };
  }
  return null;
}
