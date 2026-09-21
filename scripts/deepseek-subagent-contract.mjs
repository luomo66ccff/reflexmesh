// Fixed synthetic-transport receipt; not a production Agent or model certification.
export const SUBAGENT_ASSERTIONS = Object.freeze([
  'isolated_cli_profile_and_loader',
  'official_spawn_provider_and_lineage',
  'synthetic_parent_and_children_completed',
  'same_call_id_distinct_agent_keys',
  'parent_summary_before_delegation',
  'plain_child_did_not_inherit_parent_summary',
  'declared_child_has_only_child_summary',
  'parent_summary_unaffected_after_children',
  'native_results_and_outcomes_correlated',
  'shadow_abstain_scope_and_action_bound',
  'zero_independent_labels',
  'natural_exit_and_observer_drain',
]);
export const SUBAGENT_FAILURES = Object.freeze([
  'host_package_missing', 'unsupported_host_version', 'unsupported_package_layout',
  'isolated_cli_boot_failed', 'evidence_assertion_failed',
  'host_timeout', 'host_stdout_limit_exceeded', 'host_stderr_limit_exceeded',
  'host_exit_nonzero', 'host_spawn_failed', 'host_process_failed',
]);
export const SUBAGENT_EVIDENCE = Object.freeze({
  evidenceLevel: 'cli_agent_subagent_isolation', agentE2E: false,
  modelInference: false, modelTransport: 'synthetic_adapter', classification: 'abstain',
});
export function evaluateSubagentProbeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(SUBAGENT_EVIDENCE).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === 'cli_subagent_isolation_passed'
    && version === '0.1.2-rc.1' && value.agentLoopExercised === true
    && value.assertions.length === SUBAGENT_ASSERTIONS.length
    && SUBAGENT_ASSERTIONS.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: SUBAGENT_ASSERTIONS.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && SUBAGENT_FAILURES.includes(value.reason)
    && value.agentLoopExercised === false) return { status: 'failed', reason: value.reason, version,
    assertions: SUBAGENT_ASSERTIONS.map(name => ({ name, passed: false })) };
  return null;
}
