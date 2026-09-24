import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, parseTaskIntentArgs } from '../examples/task-intent.mjs';
import { SqliteKernel } from '../adapters/sqlite-kernel.mjs';
import { evidenceMain } from '../adapters/evidence-cli.mjs';

const sink = () => ({ text: '', write(text) { this.text += text; } });

function temporaryRoot(t) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'reflexmesh-first-run-test-'));
  t.after(() => {
    const target = realpathSync(directory);
    assert.equal(dirname(target), root);
    assert.ok(basename(target).startsWith('reflexmesh-first-run-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

test('first-run options are narrow, reject duplicates and support only new output directories', () => {
  assert.deepEqual(parseTaskIntentArgs([]), { mode: 'json', outDir: null });
  assert.deepEqual(parseTaskIntentArgs(['--summary', '--out-dir', 'lesson']), { mode: 'summary', outDir: 'lesson' });
  assert.deepEqual(parseTaskIntentArgs(['--explain', '--out-dir', 'lesson']), { mode: 'explain', outDir: 'lesson' });
  assert.deepEqual(parseTaskIntentArgs(['--summary', '--help']), { mode: 'help', outDir: null });
  for (const args of [
    ['--unknown'], ['--summary', '--explain'], ['--summary', '--summary'],
    ['--out-dir'], ['--out-dir', '--summary'], ['--out-dir', 'x', '--out-dir', 'y'],
    ['--out-dir', ' leading'], ['--out-dir', 'line\nbreak'], ['--help', '--summary'], ['--summary', '--out-dir', 'lesson', '--help'],
  ]) assert.throws(() => parseTaskIntentArgs(args));
});

test('WAL write gate runs before creating the selected output directory', async t => {
  const root = temporaryRoot(t), outputPath = join(root, 'not-created');
  await assert.rejects(main(['--out-dir', outputPath], sink(), {
    assertRuntime() { throw new Error('fixture blocks persistent writes'); },
  }), /fixture blocks persistent writes/);
  assert.equal(existsSync(outputPath), false);
});

test('default walkthrough uses fixtures only and removes its temporary data', async () => {
  const savedFetch = globalThis.fetch, output = sink();
  globalThis.fetch = () => { throw new Error('Network access is forbidden in this test'); };
  try { assert.equal(await main([], output), 0); }
  finally { globalThis.fetch = savedFetch; }
  const report = JSON.parse(output.text);
  assert.equal(report.missingIntent.providerCalls, 0);
  assert.equal(report.totalFixturePredictions, 1);
  assert.equal(report.duplicate.replayed, true);
  assert.deepEqual(report.hostOutcomeTransition, { before: 'missing', after: 'succeeded', observations: 1 });
  assert.equal(report.selectedSummaryInJournal, false);
  assert.equal(report.unselectedBodyInCache, false);
  assert.equal(report.labelsCreated, 0);
  assert.equal(report.retainedLedger, undefined);
});

test('default first-run summary explains the evidence chain and a safe next step', async () => {
  const output = sink();
  assert.equal(await main(['--summary'], output), 0);
  assert.match(output.text, /No selected task -> escalate; fixture provider calls: 0/);
  assert.match(output.text, /Selected task summary -> allow in shadow mode; repeated call reused the decision: true/);
  assert.match(output.text, /Fixture host report: missing -> succeeded \(1 observation\); labels created: 0/);
  assert.match(output.text, /After task clear -> escalate; coverage: none \(old summary not reused\)/);
  assert.match(output.text, /A shadow allow is not host permission/);
  assert.match(output.text, /Temporary ledger and task-summary cache were removed/);
  assert.match(output.text, /Next: npm run demo:evidence/);
});

test('cleanup failure cannot print a completed or removed first-run receipt', async t => {
  const tempRoot = realpathSync(tmpdir()), paths = [];
  t.after(() => {
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const target = realpathSync(path), stat = lstatSync(target);
      assert.equal(dirname(target), tempRoot);
      assert.ok(basename(target).startsWith('rm-task-demo-') || basename(target).startsWith('rm-task-cache-'));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      rmSync(target, { recursive: true, force: false });
    }
  });
  for (const args of [['--summary'], ['--explain']]) {
    const output = sink();
    await assert.rejects(main(args, output, {
      removeTemporaryDirectory(path) { paths.push(path); throw new Error('Injected cleanup failure'); },
    }), /Temporary cleanup could not be verified/);
    assert.equal(output.text.includes('lesson complete'), false);
    assert.equal(output.text.includes('were removed'), false);
    assert.equal(output.text.includes('is deleted on exit'), false);
    assert.ok(paths.length > 0);
  }
  const retained = join(temporaryRoot(t), 'retained'), output = sink();
  await assert.rejects(main(['--summary', '--out-dir', retained], output, {
    removeTemporaryDirectory(path) { paths.push(path); throw new Error('Injected cache cleanup failure'); },
  }), /Temporary cleanup could not be verified/);
  assert.equal(output.text, '');
  assert.ok(existsSync(join(retained, 'ledger.sqlite')));
});

test('retained lesson is private, read-only inspectable synthetic evidence and never overwrites', async t => {
  const root = temporaryRoot(t), outputDir = join(root, '证据 lesson'), output = sink();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network access is forbidden in this test'); };
  try { assert.equal(await main(['--summary', '--out-dir', outputDir], output), 0); }
  finally { globalThis.fetch = savedFetch; }

  assert.match(output.text, /WAL write gate passed/);
  assert.match(output.text, /3 decisions, 1 fixture prediction, 0 labels/);
  assert.match(output.text, /No selected task -> escalate; fixture provider calls: 0/);
  assert.match(output.text, /Selected task summary -> allow in shadow mode; repeated call reused the decision: true/);
  assert.match(output.text, /Fixture host report: missing -> succeeded \(1 observation\); labels created: 0/);
  assert.match(output.text, /After task clear -> escalate; coverage: none \(old summary not reused\)/);
  assert.match(output.text, /A shadow allow is not host permission/);
  assert.match(output.text, /Next: open START-HERE\.md/);
  assert.match(output.text, /No model, external provider, user profile or host tool was accessed/);
  assert.deepEqual(readdirSync(outputDir).sort(), ['START-HERE.md', 'ledger.sqlite']);
  if (process.platform !== 'win32') {
    assert.equal(statSync(outputDir).mode & 0o077, 0);
    assert.equal(statSync(join(outputDir, 'ledger.sqlite')).mode & 0o077, 0);
  }

  const databasePath = join(outputDir, 'ledger.sqlite');
  const ledger = readFileSync(databasePath);
  assert.equal(ledger.includes(Buffer.from('Read README without editing files')), false);
  assert.equal(ledger.includes(Buffer.from('PRIVATE_PROMPT_BODY_NOT_SELECTED')), false);
  const guide = readFileSync(join(outputDir, 'START-HERE.md'), 'utf8');
  assert.match(guide, /account-free synthetic fixture/);
  assert.match(guide, /evidence-cli\.mjs list/);
  assert.match(guide, /evidence-cli\.mjs attention/);
  assert.match(guide, /evidence-cli\.mjs inspect/);
  assert.ok(guide.includes(outputDir));
  assert.equal(guide.includes('Read README without editing files'), false);
  assert.equal(guide.includes('PRIVATE_PROMPT_BODY_NOT_SELECTED'), false);

  const listOutput = sink();
  await evidenceMain(['list', '--db', databasePath, '--json'], listOutput);
  const listed = JSON.parse(listOutput.text);
  assert.equal(listed.items.length, 3);
  assert.ok(listed.items.every(item => item.run.state === 'completed' && item.run.mode === 'shadow'));
  assert.ok(listed.items.every(item => item.labelCount === 0));
  const selected = listed.items.find(item => item.hostOutcome.status === 'succeeded');
  assert.ok(selected);
  assert.equal(selected.hostOutcome.byProvenance[0].provenance, 'test-oracle');
  const key = selected.key;

  const attentionOutput = sink();
  await evidenceMain(['attention', '--db', databasePath, '--json'], attentionOutput);
  const attention = JSON.parse(attentionOutput.text);
  assert.equal(attention.items.length, 2);
  assert.ok(attention.items.every(item => item.attention.reasons.some(reason => reason.code === 'shadow_outcome_missing')));
  const inspectOutput = sink();
  await evidenceMain(['inspect', '--db', databasePath, '--key', key, '--json'], inspectOutput);
  const inspected = JSON.parse(inspectOutput.text);
  assert.equal(inspected.hostOutcome.status, 'succeeded');
  assert.equal(inspected.labelCount, 0);
  assert.equal(inspected.recovery.executionAllowed, false);
  assert.deepEqual(readFileSync(databasePath), ledger);

  const guideBefore = readFileSync(join(outputDir, 'START-HERE.md'));
  await assert.rejects(main(['--out-dir', outputDir], sink()));
  assert.deepEqual(readFileSync(databasePath), ledger);
  assert.deepEqual(readFileSync(join(outputDir, 'START-HERE.md')), guideBefore);
  assert.deepEqual(readdirSync(outputDir).filter(name => !['ledger.sqlite-shm', 'ledger.sqlite-wal'].includes(name)).sort(),
    ['START-HERE.md', 'ledger.sqlite']);
});

test('npm first-run forwards a Unicode/spaced output path and leaves no task-summary cache', t => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) return t.skip('npm_execpath is only available when running the repository test script');
  const root = temporaryRoot(t), outputDir = join(root, 'npm first-run lesson');
  const result = spawnSync(process.execPath, [npmCli, 'run', 'first-run', '--', '--out-dir', outputDir], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, REFLEXMESH_PROVIDER: 'deepseek', REFLEXMESH_ALLOW_REMOTE: 'true', DEEPSEEK_API_KEY: 'SYNTHETIC-SECRET' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Synthetic evidence: 3 decisions, 1 fixture prediction, 0 labels/);
  assert.match(result.stdout, /Fixture host report: missing -> succeeded \(1 observation\)/);
  assert.equal(result.stdout.includes('SYNTHETIC-SECRET'), false);
  assert.deepEqual(readdirSync(outputDir).sort(), ['START-HERE.md', 'ledger.sqlite']);
  assert.equal(lstatSync(outputDir).isSymbolicLink(), false);
});
