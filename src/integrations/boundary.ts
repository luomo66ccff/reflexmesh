import type { Json } from '../core/types.js';
import { assertJson, ContractError, record, snapshot } from '../core/validation.js';

export type Harness = 'codex' | 'claude-code' | 'deepseek-harness' | 'openai-compatible';
export interface HarnessCall {
  readonly schemaVersion: 1;
  readonly harness: Harness;
  readonly sessionId: string;
  readonly agentId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: Json;
}
export interface HostIdentity { readonly sessionId: string; readonly agentId: string }
export function validateCall(value: unknown): asserts value is HarnessCall {
  assertJson(value);
  if (!record(value) || value.schemaVersion !== 1 || !['codex','claude-code','deepseek-harness','openai-compatible'].includes(value.harness as string)) throw new ContractError('Invalid harness envelope');
  for (const key of ['sessionId','agentId','callId','toolName']) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 256) throw new ContractError(`Invalid harness ${key}`);
  }
  if (!Object.hasOwn(value, 'arguments')) throw new ContractError('Missing tool arguments');
}
function call(value: HarnessCall): HarnessCall { validateCall(value); return snapshot(value); }
export function fromClaudeHook(payload: unknown): { call: HarnessCall; phase: 'before' | 'after'; status?: 'succeeded' | 'failed' | 'unknown'; evidence?: Json } {
  assertJson(payload);
  if (!record(payload) || !['PreToolUse','PostToolUse','PostToolUseFailure'].includes(payload.hook_event_name as string)) throw new ContractError('Unsupported Claude hook');
  const normalized = call({ schemaVersion: 1, harness: 'claude-code', sessionId: payload.session_id as string,
    agentId: (payload.agent_id ?? 'root') as string, callId: payload.tool_use_id as string,
    toolName: payload.tool_name as string, arguments: payload.tool_input as Json });
  if (payload.hook_event_name === 'PreToolUse') return { call: normalized, phase: 'before' };
  return { call: normalized, phase: 'after', status: payload.hook_event_name === 'PostToolUseFailure' ? 'failed' : 'succeeded',
    evidence: (payload.tool_response ?? payload.error ?? null) as Json };
}
/** Host resolves identity from its authenticated session; never serialize the agent/context object. */
export function fromDeepSeekCall(exec: { callId: string; name: string; arguments: unknown }, identity: HostIdentity): HarnessCall {
  assertJson(exec.arguments);
  return call({ schemaVersion: 1, harness: 'deepseek-harness', sessionId: identity.sessionId, agentId: identity.agentId,
    callId: exec.callId, toolName: exec.name, arguments: exec.arguments });
}
export function fromOpenAICompatible(value: unknown, identity: HostIdentity): HarnessCall {
  assertJson(value);
  if (!record(value) || value.type !== 'function' || !record(value.function) || typeof value.function.arguments !== 'string') throw new ContractError('Invalid function call');
  let args: unknown;
  try { args = JSON.parse(value.function.arguments); } catch { throw new ContractError('Invalid function arguments JSON'); }
  assertJson(args);
  return call({ schemaVersion: 1, harness: 'openai-compatible', sessionId: identity.sessionId, agentId: identity.agentId,
    callId: value.id as string, toolName: value.function.name as string, arguments: args });
}
