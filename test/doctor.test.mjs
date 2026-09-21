import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnoseDoctor, formatDoctor, loaderInsert, parseDoctorOptions } from '../adapters/doctor.mjs';
import { doctorMain } from '../adapters/doctor-cli.mjs';
import { inspectAgentPackages } from '../adapters/deepseek-installation.mjs';

const hostVersion = '0.1.2-rc.1';
const installed = { dsh: hostVersion, 'dsh-llm': hostVersion, 'dsh-tools': hostVersion,
  'dsh-agent': hostVersion, 'dsh-agent-loop': hostVersion, 'dsh-session': hostVersion,
  'dsh-session-projection': hostVersion, 'dsh-system-prompt': hostVersion,
  'dsh-agent-default-model': hostVersion, 'dsh-headless': hostVersion,
  cordis: '4.0.2', 'cordis-plugin-loader': '1.0.3', 'cordis-plugin-timer': '1.1.4' };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-doctor-test-'));
  return { root, db: join(root, '中文 空格', 'ledger.sqlite'), packageRoot: join(root, 'packages', 'dsh'),
    cleanup() {
      const target = realpathSync(root);
      const rel = relative(realpathSync(tmpdir()), target);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
        && basename(target).startsWith('reflexmesh-doctor-test-'));
      rmSync(target, { recursive: true, force: true });
    } };
}
function fakePackages(root, dshVersion = hostVersion) {
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(dirname(root), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`,
      version: name === 'dsh' ? dshVersion : version }));
  }
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(dirname(root), 'dsh-headless', 'lib'));
  writeFileSync(join(root, 'lib', 'bin.js'), "throw new Error('host code must never run');\n");
  writeFileSync(join(dirname(root), 'dsh-headless', 'lib', 'startup.js'), "throw new Error('host code must never run');\n");
}
const args = w => ['--deepseek-package-root', w.packageRoot, '--db', w.db, '--tenant', '测试 tenant', '--scope', '项目 scope'];
const codes = report => report.diagnostics.map(item => item.code);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function database(path, version, row = null) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE runs (key TEXT PRIMARY KEY, request_digest TEXT, state TEXT, epoch INTEGER,
      owner TEXT, lease_until INTEGER, evidence TEXT, result TEXT);
      CREATE TABLE observations (run_key TEXT, id TEXT, body TEXT);
      CREATE TABLE labels (run_key TEXT, id TEXT, body TEXT);
      ${version === 2 ? 'CREATE TABLE recovery_reviews (run_key TEXT, applied_epoch INTEGER, body TEXT);' : ''}
      PRAGMA user_version=${version};`);
    if (row) {
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)').run(row.key, 'a'.repeat(64), row.state,
        1, 'fixture', 0, JSON.stringify(row.evidence), JSON.stringify(row.result));
      for (const [id, outcome] of (row.outcomes ?? []).entries()) db.prepare('INSERT INTO observations VALUES(?,?,?)')
        .run(row.key, `observation-${id}`, JSON.stringify(typeof outcome === 'string'
          ? { status: outcome, provenance: 'harness-reported' } : outcome));
    }
  } finally { db.close(); }
}

test('help and no-args are fixed and do not discover an account or profile', async () => {
  assert.deepEqual(parseDoctorOptions(['--help']), { help: true });
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await doctorMain(['--help'], output), 0);
  assert.match(output.text, /read-only/);
  const noArgs = await diagnoseDoctor([]);
  assert.equal(noArgs.exitCode, 1);
  assert.deepEqual(codes(noArgs.report).filter(code => code.startsWith('missing_')),
    ['missing_package_root', 'missing_db', 'missing_tenant', 'missing_scope']);
  assert.equal(noArgs.report.liveHost, 'live_host_unverified');
});

test('unknown, duplicate, missing-value and mixed help options produce fixed redacted JSON errors', async () => {
  const cases = [
    ['--unknown-SECRET_OPTION', 'SECRET_VALUE', '--json'],
    ['--tenant', 'SECRET_FIRST', '--tenant', 'SECRET_DUPLICATE', '--json'],
    ['--db', '--json', 'SECRET_TRAILING'],
    ['--help', '--json', 'SECRET_MIXED'],
  ];
  for (const argv of cases) {
    const output = { text: '', write(value) { this.text += value; } };
    assert.equal(await doctorMain(argv, output), 1);
    const report = JSON.parse(output.text);
    assert.equal(report.status, 'action_required');
    assert.ok(codes(report).includes('invalid_arguments'));
    assert.equal(report.setup, null);
    assert.equal(report.liveHost, 'live_host_unverified');
    assert.equal(output.text.includes('SECRET_'), false);
    assert.equal(output.text.includes('read-only'), false);
  }
});

test('direct CLI starts from an unbuilt copy with fixed build guidance', () => {
  const w = workspace();
  try {
    const destination = join(w.root, 'adapters');
    mkdirSync(destination);
    for (const name of ['doctor-cli.mjs', 'doctor.mjs', 'direct-run.mjs',
      'deepseek-installation.mjs', 'deepseek-loader-config.mjs']) {
      copyFileSync(fileURLToPath(new URL(`../adapters/${name}`, import.meta.url)), join(destination, name));
    }
    const child = spawnSync(process.execPath, [join(destination, 'doctor-cli.mjs'), '--json'],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const report = JSON.parse(child.stdout);
    assert.ok(codes(report).includes('build_required'));
    assert.equal(report.liveHost, 'live_host_unverified');
  } finally { w.cleanup(); }
});

test('pure install checks sanitize arbitrary manifest versions and never import host entry files', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    assert.equal(inspectAgentPackages(w.packageRoot).ok, true);
    assert.equal((await diagnoseDoctor(args(w))).report.prerequisites.installation.status, 'supported');
    writeFileSync(join(w.packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh',
      version: 'SECRET\u001b[31m-not-semver' }));
    assert.deepEqual(inspectAgentPackages(w.packageRoot), {
      ok: false, reason: 'unsupported_host_version', hostVersion: 'unknown',
    });
    const report = (await diagnoseDoctor(args(w))).report;
    assert.equal(report.status, 'action_required');
    assert.equal(report.prerequisites.installation.hostVersion, 'unknown');
    assert.equal(JSON.stringify(report).includes('SECRET'), false);
    writeFileSync(join(w.packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0-01' }));
    assert.equal(inspectAgentPackages(w.packageRoot).hostVersion, 'unknown');
  } finally { w.cleanup(); }
});

test('complete Chinese and space paths yield JSON-safe YAML without creating the database', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    const report = (await diagnoseDoctor([...args(w), '--json'])).report;
    assert.equal(report.status, 'prerequisites_ready');
    assert.equal(report.prerequisites.database, 'not_created');
    assert.equal(existsSync(w.db), false);
    assert.equal(existsSync(dirname(w.db)), false);
    assert.equal(report.setup.intentMode, 'off');
    assert.equal(report.setup.provider, 'abstain');
    assert.equal(report.setup.control, 'shadow');
    assert.match(report.setup.pluginUrl, /^file:\/\//);
    const row = JSON.parse(report.setup.yamlInsert.split('\n')[1].trim().slice(2));
    assert.equal(row.name, report.setup.pluginUrl);
    assert.deepEqual(row.config, { dbPath: w.db, tenantId: '测试 tenant', scope: '项目 scope', intentMode: 'off' });
    assert.equal(report.liveHost, 'live_host_unverified');
  } finally { w.cleanup(); }
});

test('unsupported Node, missing build, invalid path and control input are fixed actions', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    const result = await diagnoseDoctor(args(w), { nodeVersion: '22.15.9', buildEntry: join(w.root, 'no-dist.js') });
    assert.equal(result.exitCode, 1);
    assert.ok(codes(result.report).includes('node_unsupported'));
    assert.ok(codes(result.report).includes('build_required'));
    assert.equal(existsSync(w.db), false);
    assert.equal((await diagnoseDoctor(args(w), { nodeVersion: '24.0.0' })).report.prerequisites.node, 'supported');
    const control = (await diagnoseDoctor([...args(w).slice(0, -1), 'bad\u001b[31m'])).report;
    assert.ok(codes(control).includes('invalid_configuration'));
    assert.equal(JSON.stringify(control).includes('bad'), false);
    assert.throws(() => loaderInsert({ dbPath: 'relative.db', tenantId: 'tenant', scope: 'scope' }));
    const tooLong = join(w.root, 'x'.repeat(1025));
    assert.throws(() => loaderInsert({ dbPath: tooLong, tenantId: 'tenant', scope: 'scope' }));
    const oversized = await diagnoseDoctor(['--deepseek-package-root', w.packageRoot,
      '--db', tooLong, '--tenant', 'tenant', '--scope', 'scope']);
    assert.equal(oversized.exitCode, 1);
    assert.equal(oversized.report.setup, null);
    assert.ok(codes(oversized.report).includes('invalid_configuration'));
  } finally { w.cleanup(); }
});

test('existing empty schema 1/2 ledgers are read-only and key-ordered evidence absence is normal', async () => {
  for (const version of [1, 2]) {
    const w = workspace();
    try {
      fakePackages(w.packageRoot);
      database(w.db, version);
      const before = hash(w.db);
      const result = await diagnoseDoctor(args(w));
      assert.equal(result.exitCode, 0);
      assert.equal(result.report.prerequisites.database, 'readable');
      assert.equal(result.report.historicalEvidence.status, 'none');
      assert.equal(result.report.historicalEvidence.selection, 'first_key_order_not_latest');
      const keyed = await diagnoseDoctor([...args(w), '--key', 'missing-key']);
      assert.equal(keyed.report.historicalEvidence.status, 'none');
      assert.equal(keyed.report.historicalEvidence.selection, 'explicit_key');
      assert.equal(hash(w.db), before);
      const db = new DatabaseSync(w.db, { readOnly: true });
      try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, version); }
      finally { db.close(); }
    } finally { w.cleanup(); }
  }
});

test('directory and corrupt existing DB are action required, while missing DB is not', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    assert.equal((await diagnoseDoctor(args(w))).exitCode, 0);
    mkdirSync(w.db, { recursive: true });
    const directory = await diagnoseDoctor(args(w));
    assert.equal(directory.exitCode, 1);
    assert.ok(codes(directory.report).includes('database_invalid'));
    rmdirSync(w.db);
    writeFileSync(w.db, 'not a sqlite database');
    const corrupt = await diagnoseDoctor(args(w));
    assert.equal(corrupt.exitCode, 1);
    assert.ok(codes(corrupt.report).includes('database_invalid'));
  } finally { w.cleanup(); }
});

test('existing DB is not opened when Node or build prerequisites are unavailable', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    database(w.db, 2);
    let opens = 0;
    const openKernel = () => { opens++; throw new Error('SECRET_KERNEL_SHOULD_NOT_OPEN'); };
    for (const prerequisites of [
      { nodeVersion: '22.15.9' },
      { buildEntry: join(w.root, 'missing-dist.js') },
    ]) {
      const result = await diagnoseDoctor(args(w), { ...prerequisites, openKernel });
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.status, 'action_required');
      assert.equal(result.report.prerequisites.database, 'inspection_unavailable');
      assert.equal(result.report.historicalEvidence.status, 'not_inspected');
      assert.ok(codes(result.report).includes('database_inspection_unavailable'));
      assert.equal(JSON.stringify(result.report).includes('SECRET_'), false);
    }
    assert.equal(opens, 0);
  } finally { w.cleanup(); }
});

test('database open and close failures remain fixed database_invalid reports without exception text', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    database(w.db, 2);
    const cases = [
      { openKernel: async () => { throw new Error('SECRET_OPEN_FAILURE'); } },
      { openKernel: async () => ({
        listEvidence: () => ({ items: [] }),
        close: () => { throw new Error('SECRET_CLOSE_FAILURE'); },
      }) },
    ];
    for (const options of cases) {
      const result = await diagnoseDoctor(args(w), options);
      assert.equal(result.exitCode, 1);
      assert.equal(result.report.status, 'action_required');
      assert.equal(result.report.prerequisites.database, 'invalid');
      assert.equal(result.report.historicalEvidence.status, 'not_inspected');
      assert.ok(codes(result.report).includes('database_invalid'));
      assert.equal(JSON.stringify(result.report).includes('SECRET_'), false);
      assert.equal(formatDoctor(result.report).includes('SECRET_'), false);
    }
  } finally { w.cleanup(); }
});

test('historical missing task, conflicting outcome and UNKNOWN never become live success', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    database(w.db, 2, { key: 'SECRET_RAW_KEY', state: 'unknown', outcomes: ['succeeded', 'failed'],
      evidence: { mode: 'shadow', taskEvidence: { status: 'missing', coverage: 'none' },
        binding: { providerId: 'abstain' }, privateSummary: 'SECRET_RAW_SUMMARY' },
      result: { status: 'shadow', verdict: { effect: 'escalate', ruleId: 'provider_unavailable_or_invalid' },
        error: 'SECRET_RAW_ERROR' } });
    const result = await diagnoseDoctor([...args(w), '--key', 'SECRET_RAW_KEY']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'prerequisites_ready');
    assert.equal(result.report.historicalEvidence.status, 'historical_evidence');
    assert.equal(result.report.historicalEvidence.currentConfigurationVerified, false);
    assert.equal(result.report.historicalEvidence.taskStatus, 'missing');
    assert.equal(result.report.historicalEvidence.outcomeStatus, 'conflicting');
    assert.equal(result.report.historicalEvidence.recoveryRequired, true);
    assert.equal(result.report.historicalEvidence.executionAuthorized, false);
    assert.ok(codes(result.report).includes('historical_unknown_execution'));
    assert.ok(codes(result.report).includes('historical_outcome_conflict'));
    assert.equal(result.report.liveHost, 'live_host_unverified');
    const serialized = JSON.stringify(result.report);
    assert.equal(serialized.includes('SECRET_RAW_KEY'), false);
    assert.equal(serialized.includes('SECRET_RAW_SUMMARY'), false);
    assert.equal(serialized.includes('SECRET_RAW_ERROR'), false);
    assert.equal(serialized.includes('retry'), false);
    assert.match(formatDoctor(result.report), /doctor 不授权执行/);
  } finally { w.cleanup(); }
});

test('a completed shadow decision with an UNKNOWN reported host outcome still warns against retries', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    database(w.db, 2, { key: 'cancelled-host-call', state: 'completed', outcomes: ['unknown'],
      evidence: { mode: 'shadow', taskEvidence: { status: 'ready', coverage: 'summary-only' } },
      result: { status: 'shadow', verdict: { effect: 'escalate' } } });
    const { report } = await diagnoseDoctor(args(w));
    assert.equal(report.historicalEvidence.runState, 'completed');
    assert.equal(report.historicalEvidence.outcomeStatus, 'unknown');
    assert.equal(report.historicalEvidence.recoveryRequired, false);
    assert.equal(report.historicalEvidence.executionAuthorized, false);
    assert.ok(codes(report).includes('historical_unknown_execution'));
    assert.match(formatDoctor(report), /不得自动重试/);
  } finally { w.cleanup(); }
});

test('historical summary distinguishes harness- and model-reported outcomes without authorizing execution', async () => {
  const w = workspace();
  try {
    fakePackages(w.packageRoot);
    database(w.db, 2, { key: 'fixture-key', state: 'completed',
      outcomes: [{ status: 'succeeded', provenance: 'harness-reported' },
        { status: 'succeeded', provenance: 'model-reported' }],
      evidence: { mode: 'shadow', taskEvidence: { status: 'ready', coverage: 'summary-only' } },
      result: { status: 'shadow', verdict: { effect: 'escalate' } } });
    const result = await diagnoseDoctor([...args(w), '--key', 'fixture-key']);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.report.historicalEvidence.outcomeByProvenance,
      [{ provenance: 'harness-reported', status: 'succeeded', count: 1 },
        { provenance: 'model-reported', status: 'succeeded', count: 1 }]);
    assert.equal(result.report.historicalEvidence.executionAuthorized, false);
    assert.equal(result.report.liveHost, 'live_host_unverified');
    const human = formatDoctor(result.report);
    assert.match(human, /run=completed; decision=escalate; task=ready; REPORTED outcome=succeeded/);
    assert.match(human, /harness-reported:succeeded=1/);
    assert.match(human, /model-reported:succeeded=1/);
    assert.match(human, /doctor 不授权执行/);
  } finally { w.cleanup(); }
});
