import { lstatSync, statSync } from 'node:fs';
import { historicalProjection } from './doctor.mjs';
import { createClaudeSettings } from './claude-setup.mjs';
import { inspectExplicitClaudeExecutable } from './claude-installation.mjs';

const BUILD_ENTRY = new URL('../dist/index.js', import.meta.url);
const HOOK_ENTRY = new URL('./claude-task-hook.mjs', import.meta.url);
const OPTIONS = new Set(['claude-executable', 'db', 'tenant', 'scope', 'intent-mode', 'intent-db', 'key', 'json']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const ACTIONS = new Set(['invalid_arguments', 'missing_executable', 'missing_db', 'missing_tenant',
  'missing_scope', 'invalid_configuration', 'invalid_key', 'node_unsupported', 'build_required',
  'hook_entry_missing',
  'unsupported_host_platform', 'invalid_executable_path', 'unsupported_executable_layout',
  'host_executable_missing', 'database_invalid', 'internal_error']);
const INSTALL_FAILURES = ['unsupported_host_platform', 'invalid_executable_path',
  'unsupported_executable_layout', 'host_executable_missing'];
const note = code => ({ code, severity: ACTIONS.has(code) ? 'action' : 'info' });
const add = (items, code) => { if (!items.some(item => item.code === code)) items.push(note(code)); };
const safeText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !CONTROL.test(value);
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const isRegularFile = path => { try { return lstatSync(path).isFile(); } catch { return false; } };
const supportedNode = version => {
  const match = /^([0-9]+)\.([0-9]+)\.[0-9]+(?:[-+].*)?$/.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    && (major > 22 || major === 22 && minor >= 16);
};

export const CLAUDE_DOCTOR_USAGE = `ReflexMesh Claude first-run doctor (read-only)
  node adapters/claude-doctor-cli.mjs --claude-executable ABS --db ABS --tenant ID --scope ID [--intent-mode off|explicit-summary] [--intent-db ABS] [--key KEY] [--json]
  node adapters/claude-doctor-cli.mjs --help
No profile or credential discovery; no Claude, model, hook, or tool execution; no database or settings write.
Review and manually merge the suggested settings. Do not install duplicate hooks.
`;

const MESSAGES = Object.freeze({
  invalid_arguments: '选项无效或重复；请使用 --help。',
  missing_executable: '请显式提供 --claude-executable 的本机绝对路径。',
  missing_db: '请显式提供 --db 绝对路径；doctor 不会创建数据库。',
  missing_tenant: '请显式提供 --tenant。',
  missing_scope: '请显式提供 --scope。',
  invalid_configuration: '数据库、任务摘要缓存、tenant 或 scope 配置无效。',
  invalid_key: '证据 key 无效。',
  node_unsupported: '需要 Node.js 22.16 或更高版本。',
  build_required: '缺少 dist/index.js；请先构建 ReflexMesh。',
  hook_entry_missing: '缺少普通文件形式的生产 Claude hook 入口；请检查安装或构建。',
  unsupported_host_platform: '此静态安装检查仅支持 Windows 本机 Claude .exe。',
  invalid_executable_path: 'Claude 可执行文件路径必须是无占位符的绝对路径。',
  unsupported_executable_layout: '需要显式指定普通 .exe 文件；目录、链接和 .cmd 不受支持。',
  host_executable_missing: '指定的 Claude .exe 文件不存在或不可读取。',
  database_not_created: '数据库尚不存在；doctor 不会创建它。',
  database_invalid: '已有数据库不是可读的受支持 ReflexMesh SQLite 文件。',
  database_inspection_unavailable: 'Node 版本或构建前置条件不足，暂不能只读查看已有数据库。',
  capture_off_by_default: '任务摘要捕获默认关闭。',
  capture_explicit_opt_in: '任务摘要捕获仅按显式 opt-in 建议；doctor 未读取或清空旧缓存。',
  abstain_only: '建议配置固定 abstain/shadow，不调用远端决策 provider。',
  executable_not_verified: '文件存在不证明 Claude 版本、完整性或当前已加载。',
  manual_merge_required: '请审阅并手动合并设置，避免重复安装钩子；doctor 未修改现有设置。',
  historical_task_not_ready: '所选历史记录没有可用任务摘要；不代表当前安装失败。',
  historical_outcome_conflict: '所选历史结果互相冲突；不能选定成功或自动重试。',
  historical_unknown_execution: '所选历史执行状态未知；必须独立核对，不得自动重试。',
  historical_hook_pairing_unavailable: '所选历史 Claude 钩子关联未完成或有歧义；已有结果也不能证明属于该次调用。',
  historical_evidence_only: '历史记录不证明当前配置、宿主加载或此次 tenant/scope。',
  live_host_unverified: 'doctor 未启动 Claude；当前实际加载和模型行为尚未验证。',
  internal_error: 'doctor 无法完成固定范围的检查。',
});

export function parseClaudeDoctorOptions(argv) {
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
  return new SqliteKernel(path, { readOnly: true, busyTimeoutMs: 250 });
};

/** Bounded static preflight; neither a host launch nor current-configuration certification. */
export async function diagnoseClaudeDoctor(argv, {
  nodeVersion = process.versions.node,
  platform = process.platform,
  buildEntry = BUILD_ENTRY,
  hookEntry = HOOK_ENTRY,
  inspectExecutable = inspectExplicitClaudeExecutable,
  openKernel = openReadOnlyKernel,
} = {}) {
  const parsed = parseClaudeDoctorOptions(argv);
  if (parsed.help) return { help: true, exitCode: 0 };
  const diagnostics = [];
  if (parsed.invalid) add(diagnostics, 'invalid_arguments');
  const input = parsed.invalid ? {} : parsed;
  const nodeReady = supportedNode(nodeVersion), built = isFile(buildEntry);
  if (!nodeReady) add(diagnostics, 'node_unsupported');
  if (!built) add(diagnostics, 'build_required');
  let installation = { status: 'not_checked', hostVersion: 'unverified' };
  if (platform !== 'win32') {
    installation = { status: 'unsupported_host_platform', hostVersion: 'unverified' };
    add(diagnostics, 'unsupported_host_platform');
  } else if (input['claude-executable'] === undefined) add(diagnostics, 'missing_executable');
  else {
    const inspected = inspectExecutable(input['claude-executable'], { platform });
    const reason = INSTALL_FAILURES.includes(inspected?.reason) ? inspected.reason : 'invalid_executable_path';
    installation = { status: inspected?.ok === true ? 'explicit_executable_present' : reason,
      hostVersion: 'unverified' };
    if (inspected?.ok !== true) add(diagnostics, reason);
    else add(diagnostics, 'executable_not_verified');
  }
  if (input.db === undefined) add(diagnostics, 'missing_db');
  if (input.tenant === undefined) add(diagnostics, 'missing_tenant');
  if (input.scope === undefined) add(diagnostics, 'missing_scope');
  if (input.key !== undefined && !safeText(input.key, 1024)) add(diagnostics, 'invalid_key');
  let settings = null;
  if (input.db !== undefined && input.tenant !== undefined && input.scope !== undefined) {
    try {
      settings = createClaudeSettings({ dbPath: input.db, tenantId: input.tenant, scope: input.scope,
        intentMode: input['intent-mode'] ?? 'off', intentDbPath: input['intent-db'] });
    } catch { add(diagnostics, 'invalid_configuration'); }
  }
  if (settings) {
    if (!isRegularFile(hookEntry)) add(diagnostics, 'hook_entry_missing');
    add(diagnostics, settings.env.REFLEXMESH_INTENT_MODE === 'off' ? 'capture_off_by_default' : 'capture_explicit_opt_in');
    add(diagnostics, 'abstain_only');
    add(diagnostics, 'manual_merge_required');
  }
  let database = 'not_requested';
  let historicalEvidence = { status: 'not_requested' };
  if (settings) {
    let stat;
    try { stat = statSync(settings.env.REFLEXMESH_DB); }
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
      } else {
        let kernel;
        try {
          kernel = await openKernel(settings.env.REFLEXMESH_DB);
          const item = input.key !== undefined ? kernel.evidenceSnapshot(input.key)
            : kernel.listEvidence({ limit: 1 }).items[0] ?? null;
          database = 'readable';
          if (item) {
            historicalEvidence = historicalProjection(item, input.key === undefined ? 'first_key_order_not_latest' : 'explicit_key');
            add(diagnostics, 'historical_evidence_only');
            if (historicalEvidence.taskStatus !== 'ready') add(diagnostics, 'historical_task_not_ready');
            if (historicalEvidence.outcomeStatus === 'conflicting') add(diagnostics, 'historical_outcome_conflict');
            if (['pending', 'blocked'].includes(historicalEvidence.hookPairingState)) add(diagnostics, 'historical_hook_pairing_unavailable');
            if (historicalEvidence.runState === 'unknown' || historicalEvidence.outcomeStatus === 'unknown'
              || historicalEvidence.recoveryRequired) add(diagnostics, 'historical_unknown_execution');
          } else historicalEvidence = { status: 'none',
            selection: input.key === undefined ? 'first_key_order_not_latest' : 'explicit_key' };
        } catch {
          database = 'invalid'; historicalEvidence = { status: 'not_inspected' };
          add(diagnostics, 'database_invalid');
        } finally { try { kernel?.close(); } catch {
          database = 'invalid'; historicalEvidence = { status: 'not_inspected' }; add(diagnostics, 'database_invalid');
        } }
      }
    }
  }
  add(diagnostics, 'live_host_unverified');
  const status = diagnostics.some(item => item.severity === 'action') ? 'action_required' : 'prerequisites_ready';
  return { exitCode: status === 'prerequisites_ready' ? 0 : 1, report: {
    schemaVersion: 1, kind: 'claude_first_run_doctor', status,
    prerequisites: { node: nodeReady ? 'supported' : 'unsupported', build: built ? 'ready' : 'missing',
      installation, configuration: settings ? 'ready' : 'incomplete', database },
    setup: settings ? { settings, manualMergeRequired: true, avoidDuplicateHooks: true } : null,
    historicalEvidence, liveHost: 'live_host_unverified', diagnostics,
  } };
}

export function formatClaudeDoctor(report) {
  const lines = [`ReflexMesh Claude doctor: ${report.status}`, '当前宿主状态：未验证。'];
  for (const diagnostic of report.diagnostics) lines.push(`- ${MESSAGES[diagnostic.code] ?? MESSAGES.internal_error}`);
  if (report.setup) lines.push('只读建议片段（请审阅并手动合并，勿重复安装）：',
    JSON.stringify(report.setup.settings, null, 2));
  if (report.historicalEvidence.status === 'historical_evidence') {
    const item = report.historicalEvidence;
    lines.push(`历史记录（非实时）：run=${item.runState}; decision=${item.decisionEffect}; task=${item.taskStatus}; REPORTED outcome=${item.outcomeStatus}; pairing=${item.hookPairingState}。`);
    lines.push(`上报来源：${item.outcomeByProvenance.map(group => `${group.provenance}:${group.status}=${group.count ?? 'unrecognized'}`).join(', ') || 'none'}。`);
    lines.push('历史证据仅按 key 顺序抽样或由 --key 精确指定，并非当前设置或宿主加载证明；doctor 不授权执行。');
  }
  return `${lines.join('\n')}\n`;
}

export function internalClaudeDoctorFailure() {
  return { schemaVersion: 1, kind: 'claude_first_run_doctor', status: 'action_required',
    prerequisites: { node: 'unverified', build: 'unverified',
      installation: { status: 'not_checked', hostVersion: 'unverified' },
      configuration: 'unverified', database: 'not_requested' },
    setup: null, historicalEvidence: { status: 'not_requested' }, liveHost: 'live_host_unverified',
    diagnostics: [note('internal_error'), note('live_host_unverified')] };
}
