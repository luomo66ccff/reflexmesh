#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ContractError, record, fromClaudeHook } from '../dist/index.js';
import { isDirectRun } from './direct-run.mjs';
import { oneJson } from './stdio.mjs';
import { openLocalBoundary } from './local-config.mjs';
import { IntentCache } from './intent-cache.mjs';
import { validateIntentScope } from './task-evidence.mjs';

const events = ['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','StopFailure','SessionEnd'];
export function taskHookScope(payload) {
  if (!record(payload) || !events.includes(payload.hook_event_name)) throw new ContractError('Unsupported task hook');
  return validateIntentScope({ harness: 'claude-code', sessionId: payload.session_id, agentId: payload.agent_id ?? 'root' });
}
/** A missing/invalid new summary invalidates the old summary; no transcript or filesystem reads. */
export async function observeClaudeTask(payload, { cache, boundary, resolveIntent }) {
  const scope = taskHookScope(payload);
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      if (cache) cache.capture(scope, payload.prompt);
      break;
    case 'Stop': case 'StopFailure':
      cache?.clear(scope); break;
    case 'SessionEnd':
      cache?.clearSession(scope); break;
    default: {
      const event = fromClaudeHook(payload);
      if (event.phase === 'before') await boundary.beforeClaudeHook(event.call,
        () => resolveIntent ? resolveIntent(scope) : cache?.current(scope) ?? null);
      else await boundary.afterClaudeHook(event.call, event.status, event.evidence);
    }
  }
  return {}; // Never issue a permission decision, replacement prompt, or additional context.
}
const canonicalPath = path => {
  if (existsSync(path)) return realpathSync(path);
  return existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : resolve(path);
};
export function cacheOptions(env) {
  const mode = env.REFLEXMESH_INTENT_MODE ?? 'off';
  if (!['off','explicit-summary'].includes(mode)) throw new ContractError('Unsupported intent capture mode');
  if (mode === 'off') return null;
  const db = env.REFLEXMESH_DB ? resolve(env.REFLEXMESH_DB) : join(homedir(), '.reflexmesh', 'shadow.sqlite');
  const path = env.REFLEXMESH_INTENT_DB ? resolve(env.REFLEXMESH_INTENT_DB) : join(dirname(db), 'task-intents.sqlite');
  const normalize = p => process.platform === 'win32' ? canonicalPath(p).toLowerCase() : canonicalPath(p);
  if (normalize(path) === normalize(db)) throw new ContractError('Task cache and execution ledger must be different files');
  return { path, tenantId: env.REFLEXMESH_TENANT ?? 'local', scope: env.REFLEXMESH_SCOPE ?? 'default' };
}
function invalidateExistingNamespace(options) {
  if (!options || !existsSync(options.path)) return;
  let stale;
  try {
    stale = new IntentCache(options.path, options);
    stale.clearNamespace();
  } finally { stale?.close(); }
}
export async function main(input = process.stdin, output = process.stdout, errors = process.stderr, env = process.env) {
  let kernel, cache, options;
  const warn = () => errors.write('ReflexMesh task observation unavailable; host behavior unchanged.\n');
  try {
    // Resolve the namespace before reading untrusted input so parse/size failures can
    // invalidate stale task evidence without retaining or printing the new payload.
    options = cacheOptions(env);
    const payload = await oneJson(input);
    taskHookScope(payload); // Known lifecycle and scope before opening a file.
    const isTool = ['PreToolUse','PostToolUse','PostToolUseFailure'].includes(payload.hook_event_name);
    if (isTool) fromClaudeHook(payload); // Validate tool identity before opening a file.
    const needsCache = payload.hook_event_name === 'UserPromptSubmit' || ['Stop','StopFailure','SessionEnd'].includes(payload.hook_event_name);
    // Clear/read paths do not create a missing cache. Prompt capture is explicit opt-in.
    if (options && needsCache && (payload.hook_event_name === 'UserPromptSubmit' || existsSync(options.path))) {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
      cache = new IntentCache(options.path, options);
    }
    let boundary;
    if (isTool) { const opened = openLocalBoundary(env, { taskAware: true }); kernel = opened.kernel; boundary = opened.boundary; }
    await observeClaudeTask(payload, { cache, boundary, resolveIntent: scope => {
      // A tool's durable pairing reservation precedes cache open/read failure.
      if (!options || !existsSync(options.path)) return null;
      cache ??= new IntentCache(options.path, options);
      return cache.current(scope);
    } });
  } catch {
    warn();
    // A failed new observation must not leave older evidence eligible for reuse.
    // Never create a cache while recovering from invalid input.
    try { if (cache) cache.clearNamespace(); else invalidateExistingNamespace(options); } catch { warn(); }
  }
  finally {
    try { cache?.close(); } catch { warn(); }
    try { kernel?.close(); } catch { warn(); }
  }
  output.write('{}\n');
}
if (isDirectRun(import.meta.url)) await main();
