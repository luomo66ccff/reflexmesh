// An installed-host, synthetic-model receipt for unloading during an unfinished tool body.
export const TEARDOWN_ASSERTIONS = Object.freeze([
  'isolated_cli_profile_and_loader',
  'native_agent_tool_body_entered',
  'loader_unloaded_before_native_result',
  'observer_drained_and_kernel_closed',
  'missing_result_remains_missing',
  'late_native_result_and_agent_completion',
  'host_identity_and_task_bound',
  'zero_labels_and_no_retry',
  'natural_host_exit',
]);
export const TEARDOWN_FAILURES = Object.freeze([
  'host_package_missing', 'unsupported_host_version', 'unsupported_package_layout',
  'isolated_cli_boot_failed', 'evidence_assertion_failed', 'host_timeout',
  'host_stdout_limit_exceeded', 'host_stderr_limit_exceeded', 'host_exit_nonzero',
  'host_spawn_failed', 'host_process_failed',
]);
export const TEARDOWN_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_observer_teardown', agentE2E: false,
  modelInference: false, modelTransport: 'synthetic_adapter', classification: 'abstain',
});

export function evaluateTeardownProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(TEARDOWN_EVIDENCE).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_observer_teardown_passed'
    && version === '0.1.2-rc.1' && value.agentLoopExercised === true
    && value.assertions.length === TEARDOWN_ASSERTIONS.length
    && TEARDOWN_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: TEARDOWN_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && TEARDOWN_FAILURES.includes(value.reason)
    && value.agentLoopExercised === false) {
    return { status: 'failed', reason: value.reason, version,
      assertions: TEARDOWN_ASSERTIONS.map(name => ({ name, passed: false })) };
  }
  return null;
}
