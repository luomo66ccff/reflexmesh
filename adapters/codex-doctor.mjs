import { lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createCodexSetup, isSafeCodexPath } from './codex-setup.mjs';
import { historicalProjection } from './doctor.mjs';
import { inspectSqliteRuntime } from './sqlite-runtime.mjs';

const BUILD_ENTRY = new URL('../dist/index.js', import.meta.url);
const MCP_ENTRY = new URL('./mcp-server.mjs', import.meta.url);
const OPTIONS = new Set(['node-executable', 'db', 'tenant', 'scope', 'key', 'json']);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f]/u;
const ACTIONS = new Set(['invalid_arguments', 'missing_executable', 'missing_db', 'missing_tenant',
  'missing_scope', 'invalid_executable_path', 'executable_missing', 'executable_not_regular',
  'invalid_configuration', 'invalid_key', 'node_unsupported', 'sqlite_wal_runtime_unsupported',
  'build_required', 'mcp_entry_missing', 'database_invalid', 'internal_error']);
const note = code => ({ code, severity: ACTIONS.has(code) ? 'action' : 'info' });
const add = (items, code) => { if (!items.some(item => item.code === code)) items.push(note(code)); };
const safeText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !UNSAFE_TEXT.test(value);
const isRegularFile = path => { try { return lstatSync(path).isFile(); } catch { return false; } };
const sameFileMetadata = (before, after) => before.isFile() && after.isFile()
  && before.dev === after.dev && before.ino === after.ino
  && before.size === after.size && before.mtimeMs === after.mtimeMs
  && before.ctimeMs === after.ctimeMs;
const hasWalSidecars = path => [`${path}-wal`, `${path}-shm`].some(sidecar => {
  try { lstatSync(sidecar); return true; }
  catch (error) { return error?.code !== 'ENOENT'; }
});
const supportedNode = version => {
  const match = /^([0-9]+)\.([0-9]+)\.[0-9]+(?:[-+].*)?$/u.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    && (major > 22 || major === 22 && minor >= 16);
};

export const CODEX_DOCTOR_USAGE = `ReflexMesh Codex first-run doctor (read-only)
  node adapters/codex-doctor-cli.mjs --node-executable ABS --db ABS --tenant ID --scope ID [--key KEY] [--json]
  node adapters/codex-doctor-cli.mjs --help
No profile, credential, Codex host, model, provider or tool access; no database or settings write.
Review and manually merge the suggested Codex MCP configuration.
`;

const MESSAGES = Object.freeze({
  invalid_arguments: '选项无效或重复；请使用 --help。',
  missing_executable: '请显式提供 --node-executable 的本机绝对路径。',
  missing_db: '请显式提供 --db 的本机绝对路径；doctor 不会创建数据库。',
  missing_tenant: '请显式提供 --tenant。',
  missing_scope: '请显式提供 --scope。',
  invalid_executable_path: 'Node 可执行文件路径必须是安全的本机绝对路径。',
  executable_missing: '显式指定的 Node 可执行文件不存在或无法读取。',
  executable_not_regular: 'Node 可执行文件必须是普通文件，不能是目录或符号链接。',
  executable_version_unverified: '文件存在不证明该可执行文件版本、完整性或 Codex 已加载它。',
  invalid_configuration: '数据库路径、tenant 或 scope 配置无效。',
  invalid_key: '证据 key 无效。',
  node_unsupported: '当前进程需要 Node.js 22.16 或更高版本。',
  sqlite_wal_runtime_unsupported: '当前 SQLite 未确认包含 WAL-reset 修复；只读历史检查仍可用。请运行 node adapters/runtime-cli.mjs 并参考 docs/SQLITE-RUNTIME.md。',
  build_required: '缺少 dist/index.js；请先构建 ReflexMesh。',
  mcp_entry_missing: '缺少普通文件形式的生产 MCP 入口 adapters/mcp-server.mjs。',
  database_not_created: '数据库尚不存在；doctor 不会创建它。',
  database_invalid: '已有数据库不是可读的受支持 ReflexMesh SQLite 文件。',
  database_inspection_unavailable: '当前 Node 版本或构建前置条件不足，暂不能只读查看已有数据库。',
  database_live_wal_unavailable: 'WAL 旁文件存在或无法确认不存在；doctor 跳过历史检查以保持无写入。',
  database_changed_during_inspection: '历史检查期间文件元数据或 WAL 旁文件状态发生变化；结果已丢弃。',
  abstain_only: '建议配置固定 abstain；MCP 仅提供咨询性 shadow 证据。',
  manual_merge_required: '请审阅并手动合并 TOML；doctor 未修改设置。',
  historical_task_not_ready: '所选历史记录没有可用任务摘要；不代表当前安装失败。',
  historical_outcome_conflict: '所选历史结果互相冲突；不能选定成功或自动重试。',
  historical_unknown_execution: '所选历史执行状态未知；须独立核对，不得自动重试。',
  historical_hook_pairing_unavailable: '所选历史钩子关联未完成或有歧义；已有结果不能证明属于该次调用。',
  historical_evidence_only: '历史记录不证明当前配置、Codex 加载或此次 tenant/scope。',
  live_host_unverified: 'doctor 未启动 Codex；实际加载和模型行为尚未验证。',
  internal_error: 'doctor 无法完成固定范围的检查。',
});

export function parseCodexDoctorOptions(argv) {
  if (!Array.isArray(argv)) return { invalid: true };
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = typeof arg === 'string' && arg.startsWith('--') ? arg.slice(2) : '';
    if (!OPTIONS.has(name) || Object.hasOwn(values, name)) return { invalid: true };
    if (name === 'json') { values.json = true; continue; }
    const value = argv[++i];
    if (!safeText(value, 4096) || value.startsWith('--')) return { invalid: true };
    values[name] = value;
  }
  return values;
}

const openReadOnlyKernel = async path => {
  const { SqliteKernel } = await import('./sqlite-kernel.mjs');
  const uri = pathToFileURL(path);
  uri.searchParams.set('immutable', '1');
  return new SqliteKernel(uri.href, { readOnly: true, busyTimeoutMs: 250 });
};

/** Bounded static preflight, never a host connection or execution certificate. */
export async function diagnoseCodexDoctor(argv, {
  nodeVersion = process.versions.node,
  buildEntry = BUILD_ENTRY,
  mcpEntry = MCP_ENTRY,
  openKernel = openReadOnlyKernel,
  inspectRuntime = inspectSqliteRuntime,
} = {}) {
  const parsed = parseCodexDoctorOptions(argv);
  if (parsed.help) return { help: true, exitCode: 0 };
  const diagnostics = [];
  if (parsed.invalid) add(diagnostics, 'invalid_arguments');
  const input = parsed.invalid ? {} : parsed;
  const nodeReady = supportedNode(nodeVersion), built = isRegularFile(buildEntry), entryReady = isRegularFile(mcpEntry);
  if (!nodeReady) add(diagnostics, 'node_unsupported');
  const sqliteRuntime = inspectRuntime();
  if (!sqliteRuntime.persistentWriteAllowed) add(diagnostics, 'sqlite_wal_runtime_unsupported');
  if (!built) add(diagnostics, 'build_required');
  if (!entryReady) add(diagnostics, 'mcp_entry_missing');

  let executable = 'not_checked';
  const executablePath = input['node-executable'];
  if (executablePath === undefined) add(diagnostics, 'missing_executable');
  else if (!isSafeCodexPath(executablePath)) {
    executable = 'invalid_path'; add(diagnostics, 'invalid_executable_path');
  } else {
    try {
      const stat = lstatSync(executablePath);
      if (stat.isFile()) {
        executable = 'explicit_file_present'; add(diagnostics, 'executable_version_unverified');
      } else { executable = 'not_regular'; add(diagnostics, 'executable_not_regular'); }
    } catch (error) {
      executable = error?.code === 'ENOENT' ? 'missing' : 'unavailable';
      add(diagnostics, 'executable_missing');
    }
  }

  if (input.db === undefined) add(diagnostics, 'missing_db');
  if (input.tenant === undefined) add(diagnostics, 'missing_tenant');
  if (input.scope === undefined) add(diagnostics, 'missing_scope');
  if (input.key !== undefined && !safeText(input.key, 1024)) add(diagnostics, 'invalid_key');
  let setup = null;
  if (executablePath !== undefined && input.db !== undefined
    && input.tenant !== undefined && input.scope !== undefined) {
    try { setup = createCodexSetup({ nodePath: executablePath, dbPath: input.db,
      tenantId: input.tenant, scope: input.scope }); }
    catch { add(diagnostics, 'invalid_configuration'); }
  }
  if (setup) { add(diagnostics, 'abstain_only'); add(diagnostics, 'manual_merge_required'); }

  let database = 'not_requested';
  let historicalEvidence = { status: 'not_requested' };
  if (setup && (input.key === undefined || !diagnostics.some(item => item.code === 'invalid_key'))) {
    let stat;
    try { stat = lstatSync(setup.env.REFLEXMESH_DB); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        database = 'not_created'; historicalEvidence = { status: 'database_not_created' };
        add(diagnostics, 'database_not_created');
      } else { database = 'invalid'; add(diagnostics, 'database_invalid'); }
    }
    if (stat) {
      if (!stat.isFile()) { database = 'invalid'; add(diagnostics, 'database_invalid'); }
      else if (!built || !nodeReady) {
        database = 'inspection_unavailable'; historicalEvidence = { status: 'not_inspected' };
        add(diagnostics, 'database_inspection_unavailable');
      } else if (hasWalSidecars(setup.env.REFLEXMESH_DB)) {
        database = 'inspection_unavailable'; historicalEvidence = { status: 'not_inspected' };
        add(diagnostics, 'database_live_wal_unavailable');
      } else {
        let kernel;
        try {
          kernel = await openKernel(setup.env.REFLEXMESH_DB);
          const item = input.key !== undefined ? kernel.evidenceSnapshot(input.key)
            : kernel.listEvidence({ limit: 1 }).items[0] ?? null;
          database = 'readable';
          if (item) {
            historicalEvidence = historicalProjection(item,
              input.key === undefined ? 'first_key_order_not_latest' : 'explicit_key');
            add(diagnostics, 'historical_evidence_only');
            if (historicalEvidence.taskStatus !== 'ready') add(diagnostics, 'historical_task_not_ready');
            if (historicalEvidence.outcomeStatus === 'conflicting') add(diagnostics, 'historical_outcome_conflict');
            if (['pending', 'blocked'].includes(historicalEvidence.hookPairingState))
              add(diagnostics, 'historical_hook_pairing_unavailable');
            if (historicalEvidence.runState === 'unknown' || historicalEvidence.outcomeStatus === 'unknown'
              || historicalEvidence.recoveryRequired) add(diagnostics, 'historical_unknown_execution');
          } else historicalEvidence = { status: 'none',
            selection: input.key === undefined ? 'first_key_order_not_latest' : 'explicit_key' };
        } catch {
          database = 'invalid'; historicalEvidence = { status: 'not_inspected' };
          add(diagnostics, 'database_invalid');
        } finally {
          try { kernel?.close(); } catch {
            database = 'invalid'; historicalEvidence = { status: 'not_inspected' };
            add(diagnostics, 'database_invalid');
          }
        }
        try {
          if (!sameFileMetadata(stat, lstatSync(setup.env.REFLEXMESH_DB))
            || hasWalSidecars(setup.env.REFLEXMESH_DB)) {
            database = 'inspection_unavailable'; historicalEvidence = { status: 'not_inspected' };
            add(diagnostics, 'database_changed_during_inspection');
          }
        } catch {
          database = 'inspection_unavailable'; historicalEvidence = { status: 'not_inspected' };
          add(diagnostics, 'database_changed_during_inspection');
        }
      }
    }
  }
  add(diagnostics, 'live_host_unverified');
  const status = diagnostics.some(item => item.severity === 'action') ? 'action_required' : 'prerequisites_ready';
  return { exitCode: status === 'prerequisites_ready' ? 0 : 1, report: {
    schemaVersion: 1, kind: 'codex_first_run_doctor', status,
    prerequisites: { node: nodeReady ? 'supported' : 'unsupported', sqliteRuntime,
      build: built ? 'ready' : 'missing', mcpEntry: entryReady ? 'ready' : 'missing',
      executable: { status: executable, version: 'unverified' },
      configuration: setup ? 'ready' : 'incomplete', database },
    setup, historicalEvidence, liveHost: 'live_host_unverified', diagnostics,
  } };
}

export function formatCodexDoctor(report) {
  const lines = [`ReflexMesh Codex doctor: ${report.status}`, '当前宿主状态：未验证。'];
  const runtime = report.prerequisites.sqliteRuntime;
  if (runtime) lines.push(`当前进程：Node ${runtime.nodeVersion}; SQLite ${runtime.sqliteVersion ?? 'unknown'}; WAL-reset fix=${runtime.walResetFix}。`);
  for (const diagnostic of report.diagnostics) lines.push(`- ${MESSAGES[diagnostic.code] ?? MESSAGES.internal_error}`);
  if (report.setup) lines.push('只读建议片段（请审阅并手动合并）：', report.setup.toml.trimEnd());
  if (report.historicalEvidence.status === 'historical_evidence') {
    const item = report.historicalEvidence;
    lines.push(`历史记录（非实时）：run=${item.runState}; decision=${item.decisionEffect}; task=${item.taskStatus}; REPORTED outcome=${item.outcomeStatus}; pairing=${item.hookPairingState}。`);
    lines.push(`上报来源：${item.outcomeByProvenance.map(group => `${group.provenance}:${group.status}=${group.count ?? 'unrecognized'}`).join(', ') || 'none'}。`);
    lines.push('历史证据仅按 key 顺序抽样或由 --key 精确指定；不证明当前设置或 Codex 加载，也不授权执行。');
  }
  return `${lines.join('\n')}\n`;
}

export function internalCodexDoctorFailure() {
  return { schemaVersion: 1, kind: 'codex_first_run_doctor', status: 'action_required',
    prerequisites: { node: 'unverified', build: 'unverified', mcpEntry: 'unverified',
      executable: { status: 'not_checked', version: 'unverified' },
      configuration: 'unverified', database: 'not_requested' },
    setup: null, historicalEvidence: { status: 'not_requested' }, liveHost: 'live_host_unverified',
    diagnostics: [note('internal_error'), note('live_host_unverified')] };
}
