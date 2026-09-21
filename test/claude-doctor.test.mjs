import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { claudeDoctorMain } from '../adapters/claude-doctor-cli.mjs';
import { diagnoseClaudeDoctor, formatClaudeDoctor, parseClaudeDoctorOptions } from '../adapters/claude-doctor.mjs';
import { inspectExplicitClaudeExecutable } from '../adapters/claude-installation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const codes = report => report.diagnostics.map(item => item.code);
const executableFixtures = new Map();
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-claude-doctor-'));
  const fixtureKeys = [];
  t.after(() => {
    for (const key of fixtureKeys) executableFixtures.delete(key);
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-claude-doctor-'));
    rmSync(target, { recursive: true, force: true });
  });
  const hostPath = (name, local = join(root, name)) => {
    const path = process.platform === 'win32' ? join(root, name) : `C:\\fixture\\${basename(root)}\\${name}`;
    fixtureKeys.push(path); executableFixtures.set(path, local);
    return path;
  };
  const exeFile = join(root, 'claude.exe'), exe = hostPath('claude.exe', exeFile);
  const db = join(root, 'ledger.sqlite');
  writeFileSync(exeFile, 'throw new Error("host code must never execute")\n');
  return { root, exe, db, intent: join(root, 'task-intents.sqlite'), hostPath };
}
const args = w => ['--claude-executable', w.exe, '--db', w.db, '--tenant', 'synthetic', '--scope', 'fixture'];
const win = { platform: 'win32', inspectExecutable: (path, { platform }) =>
  inspectExplicitClaudeExecutable(path, { platform,
    lstat: candidate => lstatSync(executableFixtures.get(candidate) ?? candidate) }) };

test('help and empty options perform no host/profile/database discovery', async t => {
  const w = workspace(t);
  assert.deepEqual(parseClaudeDoctorOptions(['--help']), { help: true });
  const output = { value: '', write(value) { this.value += value; } };
  assert.equal(await claudeDoctorMain(['--help'], output), 0);
  assert.match(output.value, /read-only/);
  let inspected = 0, opened = 0;
  const result = await diagnoseClaudeDoctor([], { ...win,
    inspectExecutable: () => { inspected++; throw new Error('not requested'); },
    openKernel: async () => { opened++; throw new Error('not requested'); } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(codes(result.report).filter(code => code.startsWith('missing_')),
    ['missing_executable', 'missing_db', 'missing_tenant', 'missing_scope']);
  assert.equal(result.report.kind, 'claude_first_run_doctor');
  assert.equal(result.report.liveHost, 'live_host_unverified');
  assert.equal(inspected, 0); assert.equal(opened, 0);
  assert.equal(existsSync(w.db), false);
});

test('valid explicit .exe gives static presence only; default off and no file writes', async t => {
  const w = workspace(t), result = await diagnoseClaudeDoctor(args(w), win);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.prerequisites.installation.status, 'explicit_executable_present');
  assert.equal(result.report.prerequisites.installation.hostVersion, 'unverified');
  assert.equal(result.report.prerequisites.database, 'not_created');
  assert.equal(result.report.liveHost, 'live_host_unverified');
  assert.equal(result.report.setup.settings.env.REFLEXMESH_INTENT_MODE, 'off');
  assert.equal(result.report.setup.settings.env.REFLEXMESH_INTENT_DB, w.intent);
  assert.equal(result.report.setup.manualMergeRequired, true);
  assert.equal(result.report.setup.avoidDuplicateHooks, true);
  assert.equal(existsSync(w.db), false);
  assert.equal(existsSync(w.intent), false);
  assert.ok(codes(result.report).includes('executable_not_verified'));
  assert.ok(codes(result.report).includes('manual_merge_required'));
});

test('explicit summary opt-in sets a separate intent database without touching an old cache', async t => {
  const w = workspace(t), prior = join(w.root, 'existing-intent.sqlite');
  writeFileSync(prior, 'PRESERVE_OLD_CACHE');
  const result = await diagnoseClaudeDoctor([...args(w), '--intent-mode', 'explicit-summary',
    '--intent-db', prior], win);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.setup.settings.env.REFLEXMESH_INTENT_MODE, 'explicit-summary');
  assert.equal(result.report.setup.settings.env.REFLEXMESH_INTENT_DB, prior);
  assert.equal(readFileSync(prior, 'utf8'), 'PRESERVE_OLD_CACHE');
  assert.equal(existsSync(w.db), false);
  assert.ok(codes(result.report).includes('capture_explicit_opt_in'));
});

test('doctor rejects a ledger path beyond the kernel limit before opening a database', async t => {
  const w = workspace(t), tooLong = join(w.root, 'd'.repeat(1025 - w.root.length - 1));
  assert.equal(tooLong.length, 1025);
  let opened = 0;
  const result = await diagnoseClaudeDoctor(['--claude-executable', w.exe, '--db', tooLong,
    '--tenant', 'synthetic', '--scope', 'fixture'], { ...win,
    openKernel: async () => { opened++; throw new Error('must not open'); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.setup, null);
  assert.ok(codes(result.report).includes('invalid_configuration'));
  assert.equal(opened, 0);
});

test('doctor cannot mark a Windows drive-rooted ledger path ready', async t => {
  const w = workspace(t);
  if (process.platform !== 'win32') {
    assert.equal((await diagnoseClaudeDoctor(args(w), win)).exitCode, 0);
    return;
  }
  let opened = 0;
  for (const path of [String.raw`\ledger.sqlite`, '/ledger.sqlite']) {
    const result = await diagnoseClaudeDoctor(['--claude-executable', w.exe, '--db', path,
      '--tenant', 'synthetic', '--scope', 'fixture'], { ...win,
      openKernel: async () => { opened++; throw new Error('must not open'); } });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.setup, null);
    assert.ok(codes(result.report).includes('invalid_configuration'));
  }
  assert.equal(opened, 0);
});

test('doctor rejects existing directory and uncheckable intent paths without touching old cache', async t => {
  const w = workspace(t), prior = join(w.root, 'prior.sqlite');
  writeFileSync(prior, 'PRESERVE_OLD_CACHE');
  for (const mode of ['off', 'explicit-summary']) {
    const result = await diagnoseClaudeDoctor([...args(w), '--intent-mode', mode,
      '--intent-db', w.root], win);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.setup, null);
    assert.ok(codes(result.report).includes('invalid_configuration'));
  }
  const inaccessible = join(w.root, 'inaccessible.sqlite'), original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', path => {
    if (path === inaccessible) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
    return original(path);
  });
  const inaccessibleResult = await diagnoseClaudeDoctor([...args(w), '--intent-mode', 'explicit-summary',
    '--intent-db', inaccessible], win);
  assert.equal(inaccessibleResult.exitCode, 1);
  assert.equal(inaccessibleResult.report.setup, null);
  assert.ok(codes(inaccessibleResult.report).includes('invalid_configuration'));
  assert.equal(readFileSync(prior, 'utf8'), 'PRESERVE_OLD_CACHE');
  assert.equal(existsSync(w.db), false);
});

test('missing build is diagnosed without importing kernel or creating files', async t => {
  const w = workspace(t);
  writeFileSync(w.db, 'EXISTING_UNREAD_FIXTURE');
  let opened = 0;
  const result = await diagnoseClaudeDoctor(args(w), { ...win, buildEntry: join(w.root, 'missing-dist.js'),
    openKernel: async () => { opened++; throw new Error('unexpected open'); } });
  assert.equal(result.exitCode, 1);
  assert.ok(codes(result.report).includes('build_required'));
  assert.ok(codes(result.report).includes('database_inspection_unavailable'));
  assert.equal(result.report.prerequisites.database, 'inspection_unavailable');
  assert.equal(opened, 0);
  assert.equal(readFileSync(w.db, 'utf8'), 'EXISTING_UNREAD_FIXTURE');
});

test('missing production hook entry prevents static readiness without executing a host', async t => {
  const w = workspace(t), hookEntry = join(w.root, 'missing-hook.mjs');
  const result = await diagnoseClaudeDoctor(args(w), { ...win, hookEntry });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, 'action_required');
  assert.ok(codes(result.report).includes('hook_entry_missing'));
  assert.equal(result.report.liveHost, 'live_host_unverified');
  assert.equal(existsSync(hookEntry), false);
  assert.equal(existsSync(w.db), false);
});

test('direct CLI from an unbuilt copy gives fixed build guidance without a module crash', t => {
  const w = workspace(t), adapters = join(w.root, 'adapters');
  mkdirSync(adapters);
  for (const name of ['claude-doctor-cli.mjs', 'claude-doctor.mjs', 'claude-setup.mjs',
    'claude-installation.mjs', 'doctor.mjs', 'deepseek-installation.mjs',
    'deepseek-loader-config.mjs', 'direct-run.mjs']) {
    copyFileSync(fileURLToPath(new URL(`../adapters/${name}`, import.meta.url)), join(adapters, name));
  }
  const child = spawnSync(process.execPath, [join(adapters, 'claude-doctor-cli.mjs'), '--json'],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  const report = JSON.parse(child.stdout);
  assert.equal(report.kind, 'claude_first_run_doctor');
  assert.ok(codes(report).includes('build_required'));
  assert.equal(report.liveHost, 'live_host_unverified');
});

test('wrong platform, directory, .cmd and missing executable never imply host version support', async t => {
  const w = workspace(t);
  const other = await diagnoseClaudeDoctor(args(w), { platform: 'linux',
    inspectExecutable: () => { throw new Error('must not inspect'); } });
  assert.equal(other.report.prerequisites.installation.status, 'unsupported_host_platform');
  assert.equal(other.exitCode, 1);
  for (const [file, status] of [[w.hostPath('directory.exe', w.root), 'unsupported_executable_layout'],
    [w.hostPath('missing.exe'), 'host_executable_missing']]) {
    const result = await diagnoseClaudeDoctor(['--claude-executable', file, ...args(w).slice(2)], win);
    assert.equal(result.report.prerequisites.installation.status, status);
    assert.equal(result.report.prerequisites.installation.hostVersion, 'unverified');
    assert.equal(result.exitCode, 1);
  }
  const cmd = join(w.root, 'claude.cmd'); writeFileSync(cmd, 'exit 1');
  const result = await diagnoseClaudeDoctor(['--claude-executable', w.hostPath('claude.cmd', cmd),
    ...args(w).slice(2)], win);
  assert.equal(result.report.prerequisites.installation.status, 'unsupported_executable_layout');
});

test('bad arguments, aliases and hostile values are fixed errors without raw echo', async t => {
  const w = workspace(t);
  const badCases = [
    ['--unknown-SECRET_OPTION', 'SECRET_VALUE', '--json'],
    ['--tenant', 'SECRET_FIRST', '--tenant', 'SECRET_SECOND', '--json'],
    ['--help', '--json', 'SECRET_MIXED'],
    ['--db', '--json', 'SECRET_TRAILING'],
  ];
  for (const argv of badCases) {
    const output = { value: '', write(value) { this.value += value; } };
    assert.equal(await claudeDoctorMain(argv, output), 1);
    assert.equal(output.value.includes('SECRET_'), false);
    assert.equal(output.value.includes('Error:'), false);
    assert.equal(JSON.parse(output.value).setup, null);
  }
  for (const extras of [
    ['--intent-db', w.db],
    ['--tenant', 'bad\nENV=1'],
    ['--intent-mode', 'automatic'],
    ['--intent-db', join(w.root, '${CLAUDE_PROJECT_DIR}', 'cache.sqlite')],
  ]) {
    const base = extras[0] === '--tenant' ? args(w).filter((_, index) => index !== 4 && index !== 5) : args(w);
    const result = await diagnoseClaudeDoctor([...base, ...extras], win);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.setup, null);
    assert.ok(codes(result.report).includes(extras[0] === '--tenant' ? 'invalid_arguments' : 'invalid_configuration'));
  }
});

test('damaged existing SQLite is reported without rewrite or leaked contents', async t => {
  const w = workspace(t), secret = 'PRIVATE_BROKEN_SQLITE_CONTENT';
  writeFileSync(w.db, secret);
  const result = await diagnoseClaudeDoctor(args(w), win);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.prerequisites.database, 'invalid');
  assert.ok(codes(result.report).includes('database_invalid'));
  assert.equal(readFileSync(w.db, 'utf8'), secret);
  assert.equal(JSON.stringify(result.report).includes(secret), false);
});

test('bounded historical read preserves conflict, pairing and unknown warnings without claiming current load', async t => {
  const w = workspace(t), kernel = new SqliteKernel(w.db);
  const handle = kernel.claim({ key: 'first-key', requestDigest: digest('request'), owner: 'fixture',
    leaseMs: 1000, evidence: { mode: 'shadow', taskEvidence: { status: 'missing', coverage: 'none' } } }).handle;
  kernel.observe('first-key', { id: 'one', status: 'succeeded', provenance: 'harness-reported',
    evidenceDigest: digest('one') });
  kernel.observe('first-key', { id: 'two', status: 'failed', provenance: 'harness-reported',
    evidenceDigest: digest('two') });
  kernel.observe('first-key', { id: 'three', status: 'unknown', provenance: 'model-reported',
    evidenceDigest: digest('three') });
  assert.throws(() => kernel.beginClaudeHookPairing({ key: 'first-key', callDigest: digest('call'),
    actionDigest: digest('action'), deploymentDigest: digest('deployment') }), /legacy_unpaired/);
  kernel.abandon(handle);
  kernel.close();
  const before = readFileSync(w.db);
  const result = await diagnoseClaudeDoctor(args(w), win);
  const historical = result.report.historicalEvidence;
  assert.equal(historical.status, 'historical_evidence');
  assert.equal(historical.selection, 'first_key_order_not_latest');
  assert.equal(historical.runState, 'unknown');
  assert.equal(historical.outcomeStatus, 'conflicting');
  assert.equal(historical.hookPairingState, 'blocked');
  assert.equal(historical.currentConfigurationVerified, false);
  assert.equal(historical.executionAuthorized, false);
  assert.ok(codes(result.report).includes('historical_outcome_conflict'));
  assert.ok(codes(result.report).includes('historical_hook_pairing_unavailable'));
  assert.ok(codes(result.report).includes('historical_unknown_execution'));
  const human = formatClaudeDoctor(result.report);
  assert.match(human, /harness-reported:failed=1/);
  assert.match(human, /model-reported:unknown=1/);
  assert.equal(human.includes('first-key'), false);
  assert.equal(JSON.stringify(result.report).includes('first-key'), false);
  assert.deepEqual(readFileSync(w.db), before);
  const selected = await diagnoseClaudeDoctor([...args(w), '--key', 'first-key'], win);
  assert.equal(selected.report.historicalEvidence.selection, 'explicit_key');
});
