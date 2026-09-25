export const MISSING_RESULT_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_observer_missing_result', agentE2E: false,
  agentLoopExercised: true, nativeToolBodyEntered: true, agentCompleted: false,
  nativeResultReceived: false, modelInference: false, modelTransport: 'synthetic_adapter',
  classification: 'abstain', exitKind: 'supervisor_terminated',
});
export const MISSING_RESULT_ASSERTIONS = Object.freeze([
  'isolated_profile_and_loader', 'native_body_entered_once', 'official_unload_closed_observer',
  'pre_stop_missing_result', 'supervisor_stopped_exact_child', 'post_stop_missing_result',
  'no_native_result_or_agent_completion', 'host_identity_and_task_bound',
  'zero_labels_and_no_retry',
]);
export const MISSING_RESULT_FAILURES = Object.freeze([
  'host_package_missing', 'unsupported_host_version', 'unsupported_package_layout',
  'isolated_cli_boot_failed', 'evidence_assertion_failed', 'host_timeout',
  'host_stdout_limit_exceeded', 'host_stderr_limit_exceeded', 'host_spawn_failed',
  'host_process_failed', 'host_exited_early', 'ipc_sequence_invalid',
  'supervisor_termination_failed', 'output_directory_exists', 'output_directory_invalid',
]);
export const MISSING_RESULT_STAGES = Object.freeze(['fixture_ready', 'body_entered', 'observer_unloaded']);
export function validateMissingResultStage(value, runId, expectedIndex) {
  const stage = MISSING_RESULT_STAGES[expectedIndex];
  if (!stage || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'runId,seq,stage'
    || value.runId !== runId || value.seq !== expectedIndex + 1 || value.stage !== stage) return false;
  return true;
}
export function evaluateMissingResultProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)) return null;
  const version = value.hostVersion === '0.1.2-rc.1' ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_observer_missing_result_isolated_passed'
    && version === '0.1.2-rc.1'
    && Object.entries(MISSING_RESULT_EVIDENCE).every(([key, expected]) => value[key] === expected)
    && value.preStop?.missing === true && value.postStop?.missing === true
    && value.preStop?.key && value.preStop.key === value.postStop.key
    && value.preStop?.outcomeStatus === 'missing' && value.postStop?.outcomeStatus === 'missing'
    && value.preStop?.outcomeCount === 0 && value.postStop?.outcomeCount === 0
    && value.supervisor?.closed === true && Number.isSafeInteger(value.supervisor?.childPid)
    && value.supervisor.childPid > 0 && value.supervisor.sequence === 3
    && value.assertions.length === MISSING_RESULT_ASSERTIONS.length
    && MISSING_RESULT_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && MISSING_RESULT_FAILURES.includes(value.reason)
    && value.agentE2E === false && value.agentCompleted === false
    && value.nativeResultReceived === false && value.modelInference === false
    && value.agentLoopExercised === false && value.nativeToolBodyEntered === false
    && value.exitKind === 'unverified'
    && value.assertions.length === MISSING_RESULT_ASSERTIONS.length
    && MISSING_RESULT_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === false)) {
    return { status: 'failed', reason: value.reason, version,
      assertions: MISSING_RESULT_ASSERTIONS.map(name => ({ name, passed: false })) };
  }
  return null;
}
