import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { inspectAgentPackages } from './deepseek-installation.mjs';
import { validateDeepSeekLoaderConfig } from './deepseek-loader-config.mjs';

const SAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const VERSION = /^([0-9]+)\.([0-9]+)\.[0-9]+(?:[-+].*)?$/;
const OPTIONS = new Set(['deepseek-package-root', 'db', 'tenant', 'scope', 'key', 'json']);
const BUILD_ENTRY = new URL('../dist/index.js', import.meta.url);
const PLUGIN_URL = new URL('./deepseek-loader-plugin.mjs', import.meta.url).href;

export const DOCTOR_USAGE = `ReflexMesh DeepSeek first-run doctor (read-only)
  node adapters/doctor-cli.mjs --deepseek-package-root ABS --db ABS --tenant ID --scope ID [--key KEY] [--json]
  node adapters/doctor-cli.mjs --help
No account/profile discovery, host/model/tool execution, provider call, or database creation.
The suggested Loader row defaults to intentMode=off and an abstaining observer.
`;

const MESSAGE = Object.freeze({
  invalid_arguments: '选项无效或重复；请使用 --help。',
  missing_package_root: '请显式提供 --deepseek-package-root 绝对路径。',
  missing_db: '请显式提供 --db 绝对路径；doctor 不会创建数据库。',
  missing_tenant: '请显式提供 --tenant。',
  missing_scope: '请显式提供 --scope。',
  invalid_package_root: 'DeepSeek 包路径必须是无控制字符的绝对路径。',
  invalid_configuration: '数据库路径、tenant 或 scope 无效。',
  invalid_key: '证据 key 无效。',
  node_unsupported: '需要 Node.js 22.16 或更高版本。',
  build_required: '缺少 dist/index.js；请先构建 ReflexMesh。',
  host_package_missing: '显式指定的 DeepSeek 安装包或依赖清单缺失。',
  unsupported_host_version: 'DeepSeek 安装包版本不在已验证白名单。',
  unsupported_package_layout: 'DeepSeek 安装包入口或布局不受支持。',
  database_not_created: '数据库尚不存在；doctor 不会创建，它将在用户启用插件后由插件创建。',
  database_invalid: '已有数据库不是可读的受支持 ReflexMesh SQLite 文件。',
  database_inspection_unavailable: 'Node 版本或构建前置条件不足，暂不能只读查看已有数据库。',
  capture_off_by_default: '建议配置默认关闭任务摘要捕获；这不是安装故障。',
  abstain_only: '当前 DeepSeek 产品插件仅做 shadow 观察，决策 provider 固定 abstain。',
  historical_task_not_ready: '所选历史记录没有可用任务摘要；不代表当前安装失败。',
  historical_outcome_conflict: '所选历史结果互相冲突；不能选定成功或自动重试。',
  historical_unknown_execution: '所选历史执行状态未知；必须独立核对，不得自动重试。',
  historical_hook_pairing_unavailable: '所选历史记录的 Claude 钩子关联未完成或有歧义；已有结果也不能证明属于该次调用，须独立核对，不得自动重试。',
  historical_evidence_only: '历史记录不证明当前插件已加载，也未证实属于本次 tenant/scope 配置。',
  live_host_unverified: 'doctor 未启动宿主；当前实际加载和模型行为尚未验证。',
  internal_error: 'doctor 无法完成固定范围的检查。',
});
const ACTION_CODES = new Set([
  'invalid_arguments', 'missing_package_root', 'missing_db', 'missing_tenant', 'missing_scope',
  'invalid_package_root', 'invalid_configuration', 'invalid_key', 'node_unsupported', 'build_required',
  'host_package_missing', 'unsupported_host_version', 'unsupported_package_layout', 'database_invalid',
  'internal_error',
]);
const note = code => ({ code, severity: ACTION_CODES.has(code) ? 'action' : 'info' });
const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !SAFE_TEXT.test(value);
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const nodeSupported = version => {
  const match = VERSION.exec(version ?? '');
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && (major > 22 || major === 22 && minor >= 16);
};
const add = (items, code) => { if (!items.some(item => item.code === code)) items.push(note(code)); };
const publicEnum = (value, values, fallback) => values.includes(value) ? value : fallback;

export function parseDoctorOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!OPTIONS.has(name) || Object.hasOwn(values, name)) return { invalid: true, json: argv.includes('--json') };
    if (name === 'json') { values.json = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) return { invalid: true, json: argv.includes('--json') };
    values[name] = value;
  }
  return values;
}

function historicalProjection(item, selection) {
  const byProvenance = Array.isArray(item?.hostOutcome?.byProvenance)
    ? item.hostOutcome.byProvenance.slice(0, 16).map(group => ({
      provenance: publicEnum(group?.provenance, ['harness-reported', 'model-reported', 'test-oracle'], 'unrecognized'),
      status: publicEnum(group?.status, ['succeeded', 'failed', 'unknown'], 'unrecognized'),
      count: Number.isSafeInteger(group?.count) && group.count >= 0 ? group.count : null,
    })) : [];
  return {
    status: 'historical_evidence', selection,
    currentConfigurationVerified: false,
    executionAuthorized: false,
    runState: publicEnum(item?.run?.state, ['admitted', 'executing', 'completed', 'unknown'], 'unrecognized'),
    taskStatus: publicEnum(item?.taskEvidence?.recordedStatus,
      ['ready', 'missing', 'expired', 'withheld', 'too_large', 'invalid', 'not_recorded'], 'unrecognized'),
    taskCoverage: publicEnum(item?.taskEvidence?.coverage, ['none', 'summary-only'], 'unrecognized'),
    decisionEffect: publicEnum(item?.decision?.effect, ['allow', 'deny', 'confirm', 'escalate'], 'not_recorded'),
    outcomeStatus: publicEnum(item?.hostOutcome?.status, ['missing', 'conflicting', 'succeeded', 'failed', 'unknown'], 'unrecognized'),
    outcomeCount: Number.isSafeInteger(item?.hostOutcome?.count) && item.hostOutcome.count >= 0 ? item.hostOutcome.count : null,
    outcomeByProvenance: byProvenance,
    hookPairingState: publicEnum(item?.hostOutcome?.hookPairing?.state, ['pending', 'ready', 'blocked', 'not_recorded'], 'not_recorded'),
    recoveryRequired: item?.recovery?.required === true,
    labelCount: Number.isSafeInteger(item?.labelCount) && item.labelCount >= 0 ? item.labelCount : null,
  };
}

export function loaderInsert(config) {
  const validated = validateDeepSeekLoaderConfig(config);
  const row = { id: 'reflexmesh-observer', name: PLUGIN_URL, config: validated };
  return { pluginUrl: PLUGIN_URL, yamlInsert: `- insert:\n  - ${JSON.stringify(row)}\n` };
}

const openReadOnlyKernel = async path => {
  const { SqliteKernel } = await import('./sqlite-kernel.mjs');
  return new SqliteKernel(path, { readOnly: true, busyTimeoutMs: 250 });
};

/** A bounded local preflight, never a current-host or execution certification. */
export async function diagnoseDoctor(argv, {
  nodeVersion = process.versions.node,
  buildEntry = BUILD_ENTRY,
  inspectPackages = inspectAgentPackages,
  openKernel = openReadOnlyKernel,
} = {}) {
  const parsed = parseDoctorOptions(argv);
  if (parsed.help) return { help: true, exitCode: 0 };
  const diagnostics = [];
  if (parsed.invalid) add(diagnostics, 'invalid_arguments');
  const input = parsed.invalid ? {} : parsed;
  if (!nodeSupported(nodeVersion)) add(diagnostics, 'node_unsupported');
  const built = isFile(buildEntry);
  if (!built) add(diagnostics, 'build_required');

  const packageRoot = input['deepseek-package-root'];
  let installation = { status: 'not_checked', hostVersion: 'unknown' };
  if (packageRoot === undefined) add(diagnostics, 'missing_package_root');
  else if (!safeString(packageRoot, 4096) || !isAbsolute(packageRoot)) add(diagnostics, 'invalid_package_root');
  else {
    const inspected = inspectPackages(packageRoot);
    installation = { status: inspected.ok ? 'supported' : inspected.reason, hostVersion: inspected.hostVersion };
    if (!inspected.ok) add(diagnostics, inspected.reason);
  }

  if (input.db === undefined) add(diagnostics, 'missing_db');
  if (input.tenant === undefined) add(diagnostics, 'missing_tenant');
  if (input.scope === undefined) add(diagnostics, 'missing_scope');
  if (input.key !== undefined && !safeString(input.key, 1024)) add(diagnostics, 'invalid_key');
  let config = null, setup = null;
  if (input.db !== undefined && input.tenant !== undefined && input.scope !== undefined) {
    try {
      config = validateDeepSeekLoaderConfig({ dbPath: input.db, tenantId: input.tenant, scope: input.scope });
      setup = { ...loaderInsert(config), intentMode: 'off', provider: 'abstain', control: 'shadow' };
    } catch { add(diagnostics, 'invalid_configuration'); }
  }
  if (config) { add(diagnostics, 'capture_off_by_default'); add(diagnostics, 'abstain_only'); }

  let database = 'not_requested';
  let historicalEvidence = { status: 'not_requested' };
  if (config) {
    let stat;
    try { stat = statSync(config.dbPath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        database = 'not_created';
        historicalEvidence = { status: 'database_not_created' };
        add(diagnostics, 'database_not_created');
      } else { database = 'invalid'; add(diagnostics, 'database_invalid'); }
    }
    if (stat) {
      if (!stat.isFile()) { database = 'invalid'; add(diagnostics, 'database_invalid'); }
      else if (!built || !nodeSupported(nodeVersion)) {
        database = 'inspection_unavailable';
        historicalEvidence = { status: 'not_inspected' };
        add(diagnostics, 'database_inspection_unavailable');
      } else {
        let kernel;
        try {
          kernel = await openKernel(config.dbPath);
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
          } else historicalEvidence = { status: 'none', selection: input.key === undefined ? 'first_key_order_not_latest' : 'explicit_key' };
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
    schemaVersion: 1, kind: 'deepseek_first_run_doctor', status,
    prerequisites: { node: nodeSupported(nodeVersion) ? 'supported' : 'unsupported',
      build: built ? 'ready' : 'missing', installation, configuration: config ? 'ready' : 'incomplete', database },
    setup, historicalEvidence, liveHost: 'live_host_unverified', diagnostics,
  } };
}

export function formatDoctor(report) {
  const lines = [`ReflexMesh DeepSeek doctor: ${report.status}`, '当前宿主状态：未验证。'];
  for (const diagnostic of report.diagnostics) lines.push(`- ${MESSAGE[diagnostic.code] ?? MESSAGE.internal_error}`);
  if (report.setup) lines.push('只读建议片段（请自行审阅并手动配置）：', report.setup.yamlInsert.trimEnd());
  if (report.historicalEvidence.status === 'historical_evidence') {
    const item = report.historicalEvidence;
    lines.push(`历史记录（非实时）：run=${item.runState}; decision=${item.decisionEffect}; task=${item.taskStatus}; REPORTED outcome=${item.outcomeStatus}。`);
    lines.push(`上报来源：${item.outcomeByProvenance.map(group => `${group.provenance}:${group.status}=${group.count ?? 'unrecognized'}`).join(', ') || 'none'}。`);
    lines.push('历史证据仅按 key 顺序抽样或由 --key 精确指定，并非当前配置或当前加载证明；doctor 不授权执行。');
  }
  return `${lines.join('\n')}\n`;
}

export function internalDoctorFailure() {
  return { schemaVersion: 1, kind: 'deepseek_first_run_doctor', status: 'action_required',
    prerequisites: { node: 'unverified', build: 'unverified', installation: { status: 'not_checked', hostVersion: 'unknown' },
      configuration: 'unverified', database: 'not_requested' },
    setup: null, historicalEvidence: { status: 'not_requested' }, liveHost: 'live_host_unverified',
    diagnostics: [note('internal_error'), note('live_host_unverified')] };
}
