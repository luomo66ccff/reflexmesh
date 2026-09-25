import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexSetup } from '../adapters/codex-setup.mjs';

const input = { nodePath: process.execPath, dbPath: join(process.cwd(), 'fixture space 中文', 'ledger.sqlite'),
  tenantId: '团队 A', scope: 'local scope' };

test('pure setup emits the production MCP entry and frozen, explicit abstaining environment', () => {
  const setup = createCodexSetup({ ...input, serverName: 'reflexmesh_probe_x' });
  const entry = fileURLToPath(new URL('../adapters/mcp-server.mjs', import.meta.url));
  assert.equal(setup.command, process.execPath);
  assert.deepEqual(setup.args, [entry]);
  assert.equal(isAbsolute(setup.args[0]), true);
  assert.deepEqual(setup.env, {
    REFLEXMESH_DB: input.dbPath,
    REFLEXMESH_TENANT: input.tenantId,
    REFLEXMESH_SCOPE: input.scope,
    REFLEXMESH_PROVIDER: 'abstain',
    REFLEXMESH_ALLOW_REMOTE: 'false',
    REFLEXMESH_TASK_EVIDENCE: 'true',
  });
  assert.equal(Object.isFrozen(setup), true);
  assert.equal(Object.isFrozen(setup.args), true);
  assert.equal(Object.isFrozen(setup.env), true);
  assert.match(setup.toml, /^\[mcp_servers\.reflexmesh_probe_x\]\n/u);
  assert.ok(setup.toml.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(setup.toml.includes(`args = [${JSON.stringify(entry)}]`));
  for (const [name, value] of Object.entries(setup.env))
    assert.ok(setup.toml.includes(`${name} = ${JSON.stringify(value)}`));
  assert.throws(() => { setup.args.push('unexpected'); }, TypeError);
  assert.throws(() => { setup.env.REFLEXMESH_PROVIDER = 'remote'; }, TypeError);
});

test('Windows backslashes, quotes, spaces and Chinese text are escaped as TOML basic strings', () => {
  const dbPath = process.platform === 'win32'
    ? 'C:\\fixture space\\中文\\ledger.sqlite'
    : '/fixture space/中文/quote"ledger.sqlite';
  const setup = createCodexSetup({ ...input, dbPath, tenantId: '组"A\\B' });
  assert.ok(setup.toml.includes(`REFLEXMESH_DB = ${JSON.stringify(dbPath)}`));
  assert.ok(setup.toml.includes(`REFLEXMESH_TENANT = ${JSON.stringify('组"A\\B')}`));
  assert.equal(setup.env.REFLEXMESH_DB, dbPath);
});

test('missing, relative, nonlocal, interpolated and ambiguous input is rejected without accessors', () => {
  const invalid = [
    { ...input, nodePath: 'node' },
    { ...input, dbPath: 'relative.sqlite' },
    { ...input, dbPath: String.raw`\\synthetic.invalid\share\ledger.sqlite` },
    { ...input, dbPath: String.raw`\\?\C:\secret\ledger.sqlite` },
    { ...input, dbPath: `${process.cwd()}${sep}..${sep}ledger.sqlite` },
    { ...input, tenantId: 'bad\nENV=1' },
    { ...input, scope: '${SCOPE}' },
    { ...input, scope: '\ud800' },
    { ...input, serverName: 'name].env' },
    { ...input, serverName: '名字' },
    { ...input, extra: true },
    { ...input, get scope() { throw new Error('getter ran'); } },
  ];
  for (const candidate of invalid) assert.throws(() => createCodexSetup(candidate), /Invalid Codex setup/u);
});
