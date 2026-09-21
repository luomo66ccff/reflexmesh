import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeSettings } from '../adapters/claude-setup.mjs';
import { inspectExplicitClaudeExecutable } from '../adapters/claude-installation.mjs';

const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'SessionEnd'];
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexmesh-claude-setup-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.ok(basename(target).startsWith('reflexmesh-claude-setup-'));
    rmSync(target, { recursive: true, force: true });
  });
  return root;
}
const opts = root => ({ dbPath: join(root, 'ledger.sqlite'), tenantId: 'local', scope: 'fixture' });
function pathOfLength(root, length) {
  let path = root;
  while (path.length + 101 < length) path = join(path, 'd'.repeat(100));
  return join(path, 'd'.repeat(length - path.length - 1));
}

test('pure default settings use seven direct production hooks and non-capturing separate cache', t => {
  const root = workspace(t), settings = createClaudeSettings(opts(root));
  assert.deepEqual(Object.keys(settings), ['env', 'hooks']);
  assert.deepEqual(Object.keys(settings.hooks), events);
  assert.equal(settings.env.REFLEXMESH_PROVIDER, 'abstain');
  assert.equal(settings.env.REFLEXMESH_ALLOW_REMOTE, 'false');
  assert.equal(settings.env.REFLEXMESH_TASK_EVIDENCE, 'true');
  assert.equal(settings.env.REFLEXMESH_INTENT_MODE, 'off');
  assert.equal(settings.env.REFLEXMESH_INTENT_DB, join(root, 'task-intents.sqlite'));
  assert.equal(settings.env.REFLEXMESH_DB, join(root, 'ledger.sqlite'));
  assert.equal(Object.hasOwn(settings, 'permissions'), false);
  assert.equal(Object.hasOwn(settings, 'model'), false);
  for (const event of events) {
    assert.equal(settings.hooks[event].length, 1);
    const entry = settings.hooks[event][0];
    assert.equal(entry.hooks.length, 1);
    assert.equal(Object.hasOwn(entry, 'matcher'), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event));
    if (Object.hasOwn(entry, 'matcher')) assert.equal(entry.matcher, '*');
    assert.deepEqual(entry.hooks[0], { type: 'command', command: process.execPath,
      args: [fileURLToPath(new URL('../adapters/claude-task-hook.mjs', import.meta.url))], timeout: 10 });
    assert.match(entry.hooks[0].args[0], /claude-task-hook\.mjs$/);
    assert.equal(entry.hooks[0].args[0].includes('test/'), false);
  }
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.env));
  assert.ok(Object.isFrozen(settings.hooks.PreToolUse[0].hooks[0].args));
  assert.throws(() => { settings.env.REFLEXMESH_PROVIDER = 'jev'; }, TypeError);
  const another = createClaudeSettings(opts(root));
  assert.notEqual(settings, another);
  assert.equal(another.env.REFLEXMESH_PROVIDER, 'abstain');
});

test('explicit summary remains opt-in and retains separate absolute intent path in both modes', t => {
  const root = workspace(t), input = { ...opts(root), intentMode: 'explicit-summary',
    intentDbPath: join(root, 'private-intents.sqlite') };
  const settings = createClaudeSettings(input, { nodePath: process.execPath,
    hookPath: join(root, 'hook.mjs') });
  assert.equal(settings.env.REFLEXMESH_INTENT_MODE, 'explicit-summary');
  assert.equal(settings.env.REFLEXMESH_INTENT_DB, input.intentDbPath);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].args, [join(root, 'hook.mjs')]);
  const off = createClaudeSettings({ ...input, intentMode: 'off' });
  assert.equal(off.env.REFLEXMESH_INTENT_DB, input.intentDbPath);
});

test('ledger path accepts 1024 characters but rejects 1025 before the kernel opens', t => {
  const root = workspace(t), accepted = pathOfLength(root, 1024);
  assert.equal(accepted.length, 1024);
  assert.equal(createClaudeSettings({ ...opts(root), dbPath: accepted }).env.REFLEXMESH_DB, accepted);
  const rejected = pathOfLength(root, 1025);
  assert.equal(rejected.length, 1025);
  assert.throws(() => createClaudeSettings({ ...opts(root), dbPath: rejected }), /Invalid Claude setup/);
});

test('existing intent cache path must be a regular non-link file in both modes', t => {
  const root = workspace(t), valid = opts(root);
  const prior = join(root, 'prior.sqlite');
  writeFileSync(prior, 'DO_NOT_READ_OR_REWRITE');
  for (const intentMode of ['off', 'explicit-summary']) {
    assert.equal(createClaudeSettings({ ...valid, intentMode, intentDbPath: prior })
      .env.REFLEXMESH_INTENT_DB, prior);
    assert.throws(() => createClaudeSettings({ ...valid, intentMode, intentDbPath: root }),
      /Invalid Claude setup/);
  }
  const link = join(root, 'linked.sqlite');
  try {
    symlinkSync(prior, link, 'file');
    for (const intentMode of ['off', 'explicit-summary']) {
      assert.throws(() => createClaudeSettings({ ...valid, intentMode, intentDbPath: link }),
        /Invalid Claude setup/);
    }
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
    t.diagnostic('Windows file symlink privilege unavailable; simulated lstat link check runs below');
  }
  assert.equal(createClaudeSettings({ ...valid, intentMode: 'explicit-summary',
    intentDbPath: join(root, 'future.sqlite') }).env.REFLEXMESH_INTENT_DB, join(root, 'future.sqlite'));
  const inaccessible = join(root, 'inaccessible.sqlite');
  const simulatedLink = join(root, 'simulated-link.sqlite'), original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', path => {
    if (path === inaccessible) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
    if (path === simulatedLink) return { isFile: () => true, isSymbolicLink: () => true };
    return original(path);
  });
  assert.throws(() => createClaudeSettings({ ...valid, intentMode: 'explicit-summary',
    intentDbPath: inaccessible }), /Invalid Claude setup/);
  for (const intentMode of ['off', 'explicit-summary']) {
    assert.throws(() => createClaudeSettings({ ...valid, intentMode,
      intentDbPath: simulatedLink }), /Invalid Claude setup/);
  }
});

test('UNC and device path prefixes are rejected before any setup filesystem metadata call', t => {
  const root = workspace(t), valid = opts(root);
  let metadataCalls = 0;
  for (const name of ['existsSync', 'realpathSync', 'lstatSync']) {
    t.mock.method(fs, name, () => { metadataCalls++; throw new Error('metadata must not run'); });
  }
  const unsafe = [String.raw`\\synthetic.invalid\share\x`, '//synthetic.invalid/share/x',
    String.raw`\\?\UNC\synthetic.invalid\share\x`, String.raw`\\.\C:\x`,
    String.raw`\??\UNC\synthetic.invalid\share\x`, String.raw`\Device\Mup\synthetic.invalid\share\x`,
    '//?/UNC/synthetic.invalid/share/x'];
  for (const path of unsafe) {
    assert.throws(() => createClaudeSettings({ ...valid, dbPath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings({ ...valid, intentDbPath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings(valid, { nodePath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings(valid, { hookPath: path }), /Invalid Claude setup/);
  }
  assert.equal(metadataCalls, 0);
});

test('Windows rooted paths without a drive are rejected for every generated setting path', t => {
  if (process.platform !== 'win32') {
    const root = workspace(t), valid = opts(root);
    assert.equal(createClaudeSettings(valid).env.REFLEXMESH_DB, valid.dbPath);
    return;
  }
  const root = workspace(t), valid = opts(root);
  let metadataCalls = 0;
  for (const name of ['existsSync', 'realpathSync', 'lstatSync']) {
    t.mock.method(fs, name, () => { metadataCalls++; throw new Error('metadata must not run'); });
  }
  for (const path of [String.raw`\ledger.sqlite`, '/ledger.sqlite']) {
    assert.throws(() => createClaudeSettings({ ...valid, dbPath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings({ ...valid, intentDbPath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings(valid, { nodePath: path }), /Invalid Claude setup/);
    assert.throws(() => createClaudeSettings(valid, { hookPath: path }), /Invalid Claude setup/);
  }
  assert.equal(metadataCalls, 0);
});

test('invalid aliases, placeholders, control text and poisoned configuration objects are rejected', t => {
  const root = workspace(t), valid = opts(root);
  const bad = [
    { ...valid, dbPath: 'relative.sqlite' },
    { ...valid, intentDbPath: valid.dbPath },
    { ...valid, intentDbPath: join(root, 'sub', '..', 'ledger.sqlite') },
    { ...valid, intentDbPath: join(root, '${CLAUDE_PROJECT_DIR}', 'intent.sqlite') },
    { ...valid, dbPath: join(root, '%USERPROFILE%', 'ledger.sqlite') },
    { ...valid, tenantId: 'malicious\nENV=1' },
    { ...valid, scope: '${CLAUDE_PROJECT_DIR}' },
    { ...valid, tenantId: '%PATH%' },
    { ...valid, intentMode: 'automatic' },
    { ...valid, extra: true },
    Object.create({ ...valid }),
  ];
  for (const input of bad) assert.throws(() => createClaudeSettings(input), /Invalid Claude setup/);
  assert.throws(() => createClaudeSettings({ ...valid, get scope() { throw new Error('getter ran'); } }),
    /Invalid Claude setup/);
  assert.throws(() => createClaudeSettings(valid, { hookPath: join(root, '${CLAUDE_PROJECT_DIR}', 'hook.mjs') }),
    /Invalid Claude setup/);
  assert.throws(() => createClaudeSettings(valid, { nodePath: 'node' }), /Invalid Claude setup/);
});

test('explicit native Windows executable is checked as a regular file without execution or version claim', t => {
  const root = workspace(t), executable = join(root, 'claude.exe');
  const hostPath = name => process.platform === 'win32' ? join(root, name) : `C:\\fixture\\${name}`;
  const fixtures = new Map([[hostPath('claude.exe'), executable],
    [hostPath('missing.exe'), join(root, 'missing.exe')], [hostPath('fake.exe'), join(root, 'fake.exe')]]);
  const inspect = path => inspectExplicitClaudeExecutable(path, { platform: 'win32',
    lstat: candidate => lstatSync(fixtures.get(candidate) ?? candidate) });
  writeFileSync(executable, 'throw new Error("this fixture must never execute")\n');
  writeFileSync(join(root, 'package.json'), '{malformed manifest that must not be read');
  assert.deepEqual(inspect(hostPath('claude.exe')),
    { ok: true, status: 'explicit_executable_present', hostVersion: 'unverified' });
  assert.equal(inspectExplicitClaudeExecutable(hostPath('claude.exe'), { platform: 'linux' }).reason,
    'unsupported_host_platform');
  assert.equal(inspect(hostPath('missing.exe')).reason,
    'host_executable_missing');
  const cmd = join(root, 'claude.cmd'); writeFileSync(cmd, 'exit 1');
  fixtures.set(hostPath('claude.cmd'), cmd);
  assert.equal(inspect(hostPath('claude.cmd')).reason,
    'unsupported_executable_layout');
  assert.equal(inspect('relative.exe').reason,
    'invalid_executable_path');
  assert.equal(inspect('C:\\${CLAUDE_PROJECT_DIR}\\claude.exe').reason,
    'invalid_executable_path');
  mkdirSync(join(root, 'fake.exe'));
  assert.equal(inspect(hostPath('fake.exe')).reason,
    'unsupported_executable_layout');
});

test('explicit executable rejects UNC and device prefixes before lstat', () => {
  let metadataCalls = 0;
  const lstat = () => { metadataCalls++; throw new Error('metadata must not run'); };
  for (const path of [String.raw`\\synthetic.invalid\share\claude.exe`,
    '//synthetic.invalid/share/claude.exe', String.raw`\\?\UNC\synthetic.invalid\share\claude.exe`,
    String.raw`\\.\C:\claude.exe`, String.raw`\??\UNC\synthetic.invalid\share\claude.exe`]) {
    assert.equal(inspectExplicitClaudeExecutable(path, { platform: 'win32', lstat }).reason,
      'invalid_executable_path');
  }
  assert.equal(metadataCalls, 0);
});

test('Windows executable path requires a local drive-qualified absolute path', () => {
  let metadataCalls = 0;
  const lstat = () => { metadataCalls++; return { isFile: () => true }; };
  for (const path of [String.raw`\claude.exe`, '/claude.exe', 'C:claude.exe']) {
    assert.equal(inspectExplicitClaudeExecutable(path, { platform: 'win32', lstat }).reason,
      'invalid_executable_path');
  }
  assert.equal(metadataCalls, 0);
  assert.equal(inspectExplicitClaudeExecutable('C:/local/claude.exe', { platform: 'win32', lstat }).ok,
    true);
  assert.equal(metadataCalls, 1);
});
