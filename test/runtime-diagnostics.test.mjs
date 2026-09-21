import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { diagnoseDoctor, formatDoctor } from '../adapters/doctor.mjs';
import { diagnoseClaudeDoctor, formatClaudeDoctor } from '../adapters/claude-doctor.mjs';
import { runtimeMain } from '../adapters/runtime-cli.mjs';
import { inspectSqliteRuntime } from '../adapters/sqlite-runtime.mjs';

const blocked = Object.freeze({ schemaVersion: 1, nodeVersion: '22.16.0', sqliteVersion: '3.49.1',
  walResetFix: 'affected', persistentWriteAllowed: false, probeStatus: 'ok' });

test('both doctors report the actual SQLite gate separately and preserve read-only diagnosis', async t => {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-runtime-doctor-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-runtime-doctor-'));
    rmSync(target, { recursive: true, force: true });
  });
  const path = join(root, 'fixture.sqlite');
  writeFileSync(path, 'synthetic placeholder: injected read-only inspector');
  for (const [diagnose, format] of [[diagnoseDoctor, formatDoctor], [diagnoseClaudeDoctor, formatClaudeDoctor]]) {
    let reads = 0, closes = 0;
    const { exitCode, report } = await diagnose(['--db', path, '--tenant', 'synthetic', '--scope', 'runtime'], {
      inspectRuntime: () => blocked,
      openKernel: async selected => {
        assert.equal(selected, path); reads++;
        return { listEvidence: () => ({ items: [] }), close: () => closes++ };
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(report.status, 'action_required');
    assert.deepEqual(report.prerequisites.sqliteRuntime, blocked);
    assert.ok(report.diagnostics.some(item => item.code === 'sqlite_wal_runtime_unsupported' && item.severity === 'action'));
    assert.equal(report.prerequisites.database, 'readable');
    assert.equal(reads, 1); assert.equal(closes, 1);
    assert.match(format(report), /SQLite 3\.49\.1/);
    assert.equal(report.liveHost, 'live_host_unverified');
  }
});

test('runtime CLI reports real in-memory probe with bounded options and no ledger argument', () => {
  const output = () => ({ text: '', write(value) { this.text += value; } });
  let stream = output();
  assert.equal(runtimeMain(['--help'], stream), 0);
  assert.match(stream.text, /no build or ledger required/);
  stream = output();
  assert.equal(runtimeMain(['--json'], stream), inspectSqliteRuntime().persistentWriteAllowed ? 0 : 1);
  assert.deepEqual(JSON.parse(stream.text), inspectSqliteRuntime());
  for (const args of [['--db', 'PRIVATE_PATH'], ['--json', '--json'], ['--help', 'PRIVATE_PATH']]) {
    stream = output();
    assert.equal(runtimeMain(args, stream), 2);
    assert.doesNotMatch(stream.text, /PRIVATE_PATH/);
  }
});

test('both doctors return help before a runtime probe', async () => {
  for (const diagnose of [diagnoseDoctor, diagnoseClaudeDoctor]) {
    assert.deepEqual(await diagnose(['--help'], { inspectRuntime: () => { throw Error('must not probe'); } }),
      { help: true, exitCode: 0 });
  }
});
