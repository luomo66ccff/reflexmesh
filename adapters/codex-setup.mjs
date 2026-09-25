import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_ENTRY = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/u;
const PLACEHOLDER = /[$%`]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.?(?=[\\/]|$)/u;
const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const powershellQuote = value => `'${value.replaceAll("'", "''")}'`;
const posixQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

const plainFields = (value, allowed) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).every(key => allowed.includes(key))
  && Object.values(Object.getOwnPropertyDescriptors(value))
    .every(descriptor => Object.hasOwn(descriptor, 'value'));
const safeText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !UNSAFE_TEXT.test(value) && !LONE_SURROGATE.test(value)
  && !PLACEHOLDER.test(value);

/** Syntactic local-path validation only; this function never accesses a filesystem. */
export function isSafeCodexPath(value, max = 4096) {
  if (!safeText(value, max) || !isAbsolute(value) || PARENT_SEGMENT.test(value)) return false;
  const normalized = value.replaceAll('/', '\\');
  if (normalized.startsWith('\\\\') || /^\\(?:\?\?|Device|GLOBAL\?\?)\\/iu.test(normalized)) return false;
  if (process.platform !== 'win32') return true;
  return /^[A-Za-z]:[\\/]/u.test(value) && !/[<>:"|?*]/u.test(value.slice(2));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure, manually reviewable Codex STDIO MCP configuration fragment. */
export function createCodexSetup(input) {
  if (!plainFields(input, ['nodePath', 'dbPath', 'tenantId', 'scope', 'serverName']))
    throw new TypeError('Invalid Codex setup');
  const { nodePath, dbPath, tenantId, scope, serverName = 'reflexmesh-shadow' } = input;
  if (!isSafeCodexPath(nodePath) || !isSafeCodexPath(dbPath, 1024)
    || !safeText(tenantId, 64) || !safeText(scope, 64)
    || typeof serverName !== 'string' || !SERVER_NAME.test(serverName))
    throw new TypeError('Invalid Codex setup');
  const env = {
    REFLEXMESH_DB: dbPath,
    REFLEXMESH_TENANT: tenantId,
    REFLEXMESH_SCOPE: scope,
    REFLEXMESH_PROVIDER: 'abstain',
    REFLEXMESH_ALLOW_REMOTE: 'false',
    REFLEXMESH_TASK_EVIDENCE: 'true',
  };
  const args = [MCP_ENTRY];
  const heading = `mcp_servers.${serverName}`;
  const toml = [`[${heading}]`, `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(MCP_ENTRY)}]`, '', `[${heading}.env]`,
    ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ''].join('\n');
  // A command is only a reviewable suggestion. It must never run here or silently overwrite an existing row.
  const registrationArgs = ['mcp', 'add', serverName,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--', nodePath, MCP_ENTRY];
  const registration = registrationArgs.some(value => value.includes('"')) ? null : {
    command: 'codex', args: registrationArgs,
    powershell: `codex mcp add ${powershellQuote(serverName)} ${Object.entries(env).map(([key, value]) =>
      `--env ${powershellQuote(`${key}=${value}`)}`).join(' ')} -- ${powershellQuote(nodePath)} ${powershellQuote(MCP_ENTRY)}`,
    posix: `codex mcp add ${posixQuote(serverName)} ${Object.entries(env).map(([key, value]) =>
      `--env ${posixQuote(`${key}=${value}`)}`).join(' ')} -- ${posixQuote(nodePath)} ${posixQuote(MCP_ENTRY)}`,
    changesUserConfigIfRun: true,
  };
  return deepFreeze({ command: nodePath, args, env, toml, registration });
}

/** Bind a suggested command to the exact Codex CLI that was inspected, never to PATH lookup. */
export function bindCodexRegistration(registration, executablePath) {
  if (!registration || !isSafeCodexPath(executablePath)) throw new TypeError('Invalid Codex registration');
  const powershell = `& ${powershellQuote(executablePath)} ${registration.args.map((arg, index) =>
    index < 2 || arg === '--env' || arg === '--' ? arg : powershellQuote(arg)).join(' ')}`;
  const posix = `${posixQuote(executablePath)} ${registration.args.map((arg, index) =>
    index < 2 || arg === '--env' || arg === '--' ? arg : posixQuote(arg)).join(' ')}`;
  return deepFreeze({ ...registration, command: executablePath, powershell, posix });
}
