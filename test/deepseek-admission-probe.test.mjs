import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADMISSION_ASSERTIONS, runDeepSeekAdmissionProbe } from '../scripts/deepseek-admission-probe.mjs';

const entry = fileURLToPath(new URL('../scripts/deepseek-admission-probe.mjs', import.meta.url));
const receiptKeys = ['schemaVersion', 'evidenceLevel', 'agentE2E', 'modelInference',
  'classification', 'hostVersion', 'status', 'reason', 'assertions'];
const checkFailure = (value, reason) => {
  assert.deepEqual(Object.keys(value), receiptKeys);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.evidenceLevel, 'native_tool_outcome_admission');
  assert.equal(value.agentE2E, false);
  assert.equal(value.modelInference, false);
  assert.equal(value.classification, 'synthetic_classification');
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, reason);
  assert.deepEqual(value.assertions, ADMISSION_ASSERTIONS.map(name => ({ name, passed: false })));
};
const cleanTemp = async root => {
  const target = await realpath(root);
  const rel = relative(await realpath(tmpdir()), target);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep)
    && basename(target).startsWith('rm-admission-'));
  await rm(target, { recursive: true, force: true });
};

test('absent, relative and malformed package roots fail before host loading', async () => {
  for (const input of [undefined, null, '', '.', 'D:relative', 42, {}, 'x'.repeat(4097)]) {
    checkFailure(await runDeepSeekAdmissionProbe(input), 'invalid_arguments');
  }
});

test('missing, unsupported and malformed installed manifests fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rm-admission-packages-'));
  t.after(() => cleanTemp(root));
  const missing = join(root, 'missing');
  checkFailure(await runDeepSeekAdmissionProbe(missing), 'host_package_missing');

  const dsh = join(root, 'dsh');
  for (const name of ['dsh', 'dsh-tools', 'dsh-system-prompt', 'cordis']) {
    const base = join(root, name);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`,
      version: name === 'cordis' ? '4.0.2' : '0.1.2-rc.1' }));
  }
  await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.3' }));
  const unsupported = await runDeepSeekAdmissionProbe(dsh);
  checkFailure(unsupported, 'unsupported_host_version');
  assert.equal(unsupported.hostVersion, 'unknown');

  await writeFile(join(dsh, 'package.json'), '{ malformed JSON');
  const malformed = await runDeepSeekAdmissionProbe(dsh);
  checkFailure(malformed, 'host_package_missing');
  assert.equal(malformed.hostVersion, 'unknown');
});

test('CLI uses a fixed minimized failure receipt and rejects absent or extra arguments', () => {
  for (const args of [[], ['relative'], ['relative', 'extra']]) {
    const child = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.equal(child.error, undefined);
    // Node 22 may emit its built-in node:sqlite experimental warning on import.
    // Keep warnings enabled and reject any stderr other than that exact notice.
    assert.match(child.stderr, /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?$/);
    assert.equal(child.stdout.trim().split(/\r?\n/).length, 1);
    checkFailure(JSON.parse(child.stdout), 'invalid_arguments');
    assert.equal(child.stdout.includes('relative'), false);
  }
});
