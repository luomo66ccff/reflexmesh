// Fixed, sanitized receipt for two synthetic CLI Agent lifecycle scenarios.
export const LIFECYCLE_ASSERTIONS = Object.freeze([
  'parallel_isolated_profile_and_loader',
  'parallel_synthetic_agent_loop',
  'parallel_native_bodies_overlap',
  'parallel_reverse_body_settlement',
  'parallel_native_success_and_failure',
  'parallel_old_task_bound_to_both',
  'parallel_steer_new_task_and_digest',
  'parallel_zero_labels',
  'parallel_natural_exit_and_drain',
  'cancel_isolated_profile_and_loader',
  'cancel_synthetic_agent_loop',
  'cancel_started_body_returned_success',
  'cancel_native_aborted_result',
  'cancel_unknown_outcome_no_retry',
  'cancel_followup_new_turn_and_digest',
  'cancel_zero_labels',
  'cancel_natural_exit_and_drain',
]);

export const LIFECYCLE_FAILURES = Object.freeze([
  'host_package_missing', 'unsupported_host_version', 'unsupported_package_layout',
  'isolated_cli_boot_failed', 'evidence_assertion_failed',
  'host_timeout', 'host_stdout_limit_exceeded', 'host_stderr_limit_exceeded',
  'host_exit_nonzero', 'host_spawn_failed', 'host_process_failed',
]);

export const LIFECYCLE_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_lifecycle_matrix', agentE2E: false,
  modelInference: false, modelTransport: 'synthetic_adapter', classification: 'abstain',
});

export function evaluateLifecycleProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(LIFECYCLE_EVIDENCE).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_lifecycle_matrix_passed'
    && version === '0.1.2-rc.1' && value.agentLoopExercised === true
    && value.assertions.length === LIFECYCLE_ASSERTIONS.length
    && LIFECYCLE_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: LIFECYCLE_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && LIFECYCLE_FAILURES.includes(value.reason)
    && value.agentLoopExercised === false) {
    return { status: 'failed', reason: value.reason, version,
      assertions: LIFECYCLE_ASSERTIONS.map(name => ({ name, passed: false })) };
  }
  return null;
}
