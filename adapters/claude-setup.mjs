import fs from 'node:fs';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = fileURLToPath(new URL('./claude-task-hook.mjs', import.meta.url));
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const PLACEHOLDER = /[$%`]/;
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).every(key => allowed.includes(key))
  && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => Object.hasOwn(descriptor, 'value'));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !CONTROL.test(value);
const nonlocalPath = value => {
  const normalized = value.replaceAll('/', '\\');
  return normalized.startsWith('\\\\') || /^\\(?:\?\?|Device|GLOBAL\?\?)\\/i.test(normalized);
};
const driveQualified = value => /^[a-z]:[\\/]/i.test(value);
const pathText = (value, max = 4096) => text(value, max) && !nonlocalPath(value)
  && isAbsolute(value) && (process.platform !== 'win32' || driveQualified(value))
  && !PLACEHOLDER.test(value);

function usableIntentPath(path) {
  try {
    const stat = fs.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) { return error?.code === 'ENOENT'; }
}

function canonicalPath(path) {
  let prefix = resolve(path);
  const tail = [];
  while (!fs.existsSync(prefix)) {
    const parent = dirname(prefix);
    if (parent === prefix) break;
    tail.unshift(basename(prefix));
    prefix = parent;
  }
  const canonical = resolve(fs.existsSync(prefix) ? fs.realpathSync(prefix) : prefix, ...tail);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure, review-before-merge Claude settings fragment; never reads a profile or writes a file. */
export function createClaudeSettings(input, executable = {}) {
  if (!fields(input, ['dbPath', 'tenantId', 'scope', 'intentMode', 'intentDbPath'])
    || !fields(executable, ['nodePath', 'hookPath'])) throw new TypeError('Invalid Claude setup');
  const { dbPath, tenantId, scope, intentMode = 'off' } = input;
  if (!pathText(dbPath, 1024)) throw new TypeError('Invalid Claude setup');
  const intentDbPath = input.intentDbPath ?? join(dirname(dbPath), 'task-intents.sqlite');
  const nodePath = executable.nodePath ?? process.execPath;
  const hookPath = executable.hookPath ?? HOOK_PATH;
  if (!pathText(intentDbPath) || !pathText(nodePath) || !pathText(hookPath)
    || !text(tenantId, 64) || !text(scope, 64) || PLACEHOLDER.test(tenantId) || PLACEHOLDER.test(scope)
    || !['off', 'explicit-summary'].includes(intentMode)
    || !usableIntentPath(intentDbPath)
    || canonicalPath(dbPath) === canonicalPath(intentDbPath)) throw new TypeError('Invalid Claude setup');
  const env = { REFLEXMESH_DB: dbPath, REFLEXMESH_TENANT: tenantId, REFLEXMESH_SCOPE: scope,
    REFLEXMESH_PROVIDER: 'abstain', REFLEXMESH_ALLOW_REMOTE: 'false',
    REFLEXMESH_TASK_EVIDENCE: 'true', REFLEXMESH_INTENT_MODE: intentMode,
    REFLEXMESH_INTENT_DB: intentDbPath };
  const hooks = {};
  for (const event of EVENTS) hooks[event] = [{ ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
    hooks: [{ type: 'command', command: nodePath, args: [hookPath], timeout: 10 }] }];
  return freeze({ env, hooks });
}
