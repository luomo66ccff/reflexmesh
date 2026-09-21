#!/usr/bin/env node
// Test-only hook wrapper, never a replacement production permission boundary.
import { appendFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fromClaudeHook } from '../dist/index.js';
import { digest } from '../adapters/sqlite-kernel.mjs';
import { main as observeTaskHook } from '../adapters/claude-task-hook.mjs';
import { oneJson } from '../adapters/stdio.mjs';
import { selectExplicitSummary } from '../adapters/task-evidence.mjs';
import { isDirectRun } from '../adapters/direct-run.mjs';

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'];
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const normalize = path => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path);

export async function localHook(input = process.stdin, output = process.stdout, env = process.env) {
  let payload, permitted = false;
  try {
    payload = await oneJson(input);
    if (!EVENTS.includes(payload.hook_event_name) || !identity(payload.session_id)) throw new Error('invalid_hook');
    const file = env.REFLEXMESH_LOCAL_RECEIPTS, fixture = env.REFLEXMESH_LOCAL_FIXTURE;
    if (![file, fixture].every(value => typeof value === 'string' && isAbsolute(value))
      || normalize(dirname(file)) !== normalize(dirname(fixture))
      || !existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()
      || lstatSync(file).size > 65536) throw new Error('invalid_fixture');
    const event = payload.hook_event_name, tool = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event);
    const normalized = tool ? fromClaudeHook(payload) : null;
    permitted = event !== 'PreToolUse' || normalized.call.toolName === 'Read'
      && typeof normalized.call.arguments.file_path === 'string'
      && normalize(resolve(normalized.call.arguments.file_path)) === normalize(fixture);
    if (!permitted) throw new Error('fixture_only');
    const deliveries = event === 'PreToolUse' && env.REFLEXMESH_LOCAL_SCENARIO === 'duplicate-pre' ? 2 : 1;
    let unavailable = 0, abstained = true;
    for (let i = 0; i < deliveries; i++) {
      let response = '', warning = false;
      await observeTaskHook(Readable.from([JSON.stringify(payload)]), { write: chunk => { response += chunk; } },
        { write: () => { warning = true; } }, env);
      abstained &&= response === '{}\n';
      unavailable += Number(warning);
    }
    let cacheEmptyAfterStop = null;
    if (event === 'Stop') {
      const cache = new DatabaseSync(env.REFLEXMESH_INTENT_DB, { readOnly: true });
      try { cacheEmptyAfterStop = cache.prepare('SELECT count(*) n FROM intents').get().n === 0; }
      finally { cache.close(); }
    }
    const summary = event === 'UserPromptSubmit' ? selectExplicitSummary(payload.prompt) : null;
    const receipt = { event, pid: process.pid, sessionId: payload.session_id, agentId: payload.agent_id ?? 'root',
      deliveries, unavailable, abstained, cacheEmptyAfterStop,
      summaryDigest: summary?.status === 'ready' ? digest(summary.summary) : null,
      ...(normalized ? { callId: normalized.call.callId, callDigest: digest(normalized.call),
        actionDigest: digest({ toolId: normalized.call.toolName, args: normalized.call.arguments }),
        evidenceDigest: normalized.phase === 'after' ? digest(normalized.evidence) : null, status: normalized.status ?? null } : {}) };
    appendFileSync(file, JSON.stringify(receipt) + '\n');
    output.write('{}\n');
  } catch {
    // Deny only this test's unexpected pre-tool input. Production observer stays shadow.
    output.write(JSON.stringify(payload?.hook_event_name === 'PreToolUse' ? {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Local compatibility fixture allows only its fixed Read.' },
    } : {}) + '\n');
  }
}
if (isDirectRun(import.meta.url)) await localHook();
