import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectRun } from '../adapters/direct-run.mjs';

test('direct-run detection compares canonical paths instead of path spelling', () => {
  const canonicalize = path => path.endsWith('entry.mjs') ? '/physical/entry.mjs' : path;
  assert.equal(isDirectRun(pathToFileURL('/profile-alias/entry.mjs').href, '/real-profile/entry.mjs', canonicalize), true);
  assert.equal(isDirectRun(pathToFileURL('/profile-alias/entry.mjs').href, '/real-profile/other.mjs', canonicalize), false);
  assert.equal(isDirectRun(pathToFileURL('/profile-alias/entry.mjs').href, null, canonicalize), false);
});

test('a CLI entrypoint runs through a real directory alias but stays inert when imported', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'reflexmesh-entrypoint-'));
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const alias = join(temporary, 'repository-alias');
  try {
    await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const entrypoint = join(alias, 'adapters', 'claude-hook.mjs');
    const executed = spawnSync(process.execPath, [entrypoint], {
      input: 'malformed-fixture', encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH },
    });
    assert.equal(executed.status, 0, executed.stderr);
    assert.deepEqual(JSON.parse(executed.stdout), {});

    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `await import(${JSON.stringify(pathToFileURL(entrypoint).href)}); process.stdout.write('imported\\n')`],
    { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, 'imported\n');
  } finally {
    await unlink(alias).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
