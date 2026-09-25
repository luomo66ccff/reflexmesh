// A sanitized probe receipt, not an Agent/model production-certification claim.
export const AGENT_ASSERTIONS = Object.freeze([
  'isolated_cli_profile_loaded', 'observer_loaded_by_loader', 'observer_overlay_via_cli',
  'native_agent_loop_exercised',
  'synthetic_adapter_only', 'host_identity_bound', 'selected_task_receipt_ready',
  'agent_dispatched_fixture_tool', 'native_tool_result_correlated', 'final_marker_from_agent',
  'observer_drained_before_exit', 'fixture_tool_scope_enforced', 'zero_labels',
]);
export const AGENT_FAILURES = Object.freeze([
  'host_package_missing', 'unsupported_host_version', 'host_load_failed',
  'unsupported_package_layout', 'isolated_cli_boot_failed', 'profile_loader_failed',
  'agent_loop_failed', 'evidence_assertion_failed',
  'host_timeout', 'host_stdout_limit_exceeded', 'host_stderr_limit_exceeded',
  'host_exit_nonzero', 'host_spawn_failed', 'host_process_failed',
]);
export const AGENT_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_loop', agentE2E: false, modelInference: false,
  modelTransport: 'synthetic_adapter', classification: 'abstain',
});

export function evaluateAgentProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(AGENT_EVIDENCE).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_agent_loop_passed' && version === '0.1.2-rc.1'
    && value.agentLoopExercised && value.assertions.length === AGENT_ASSERTIONS.length
    && AGENT_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: AGENT_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && AGENT_FAILURES.includes(value.reason)) {
    return { status: 'failed', reason: value.reason, version,
      assertions: AGENT_ASSERTIONS.map(name => ({ name, passed: false })) };
  }
  return null;
}
