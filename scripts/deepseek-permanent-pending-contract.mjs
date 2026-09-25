import { TEARDOWN_FAILURES } from './deepseek-teardown-contract.mjs';

const SHARED = Object.freeze([
  'isolated_cli_profile_and_loader',
  'native_tool_result_delivered_once',
  'pending_at_unload',
  'fenced_unload_completed',
  'truthful_ledger',
  'agent_received_result_without_retry',
  'zero_labels_and_no_remote_model',
  'natural_host_exit',
]);

export const PERMANENT_PENDING = Object.freeze({
  'permanent-before': Object.freeze({
    evidenceLevel: 'cli_agent_observer_pending_before',
    reason: 'cli_observer_pending_before_passed',
    assertions: Object.freeze([...SHARED]),
  }),
  'permanent-after': Object.freeze({
    evidenceLevel: 'cli_agent_observer_pending_after',
    reason: 'cli_observer_pending_after_passed',
    assertions: Object.freeze([...SHARED]),
  }),
});

export const permanentPendingEvidence = scenario => Object.freeze({
  evidenceLevel: PERMANENT_PENDING[scenario].evidenceLevel,
  agentE2E: false, modelInference: false,
  modelTransport: 'synthetic_adapter', classification: 'abstain', scenario,
});

export function evaluatePermanentPendingProbeOutput(stdout, scenario) {
  const contract = PERMANENT_PENDING[scenario];
  if (!contract) return null;
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { return null; }
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.assertions)
    || !Object.entries(permanentPendingEvidence(scenario)).every(([key, expected]) => value[key] === expected)
    || typeof value.agentLoopExercised !== 'boolean') return null;
  const version = typeof value.hostVersion === 'string' && value.hostVersion.length <= 64
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.hostVersion)
    ? value.hostVersion : 'unknown';
  if (value.status === 'passed' && value.reason === contract.reason
    && version === '0.1.2-rc.1' && value.agentLoopExercised === true
    && value.assertions.length === contract.assertions.length
    && contract.assertions.every((name, index) => value.assertions[index]?.name === name
      && value.assertions[index]?.passed === true)) {
    return { status: 'passed', reason: value.reason, version,
      assertions: contract.assertions.map(name => ({ name, passed: true })) };
  }
  if (value.status === 'failed' && TEARDOWN_FAILURES.includes(value.reason)
    && value.agentLoopExercised === false) {
    return { status: 'failed', reason: value.reason, version,
      assertions: contract.assertions.map(name => ({ name, passed: false })) };
  }
  return null;
}
