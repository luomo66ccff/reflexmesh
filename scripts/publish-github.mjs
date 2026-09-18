#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseOptions(argv) {
  const options = { owner: 'luomo66ccff', name: 'reflexmesh', visibility: 'private', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--public') options.visibility = 'public';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--owner' || arg === '--name') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(options.owner)) throw new Error('Invalid GitHub owner');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.name) || ['.', '..'].includes(options.name)) throw new Error('Invalid repository name');
  return options;
}
export function createArgs(options, directory) {
  return ['repo', 'create', `${options.owner}/${options.name}`, `--${options.visibility}`, '--source', directory, '--remote', 'origin', '--push', '--description', 'Provider-neutral semantic decision runtime: versioned packs, deterministic policy and auditable outcomes.'];
}
const roots = ['README.md', 'LICENSE', 'AGENTS.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.env.example', 'src', 'test', 'examples', 'adapters', 'scripts', 'docs', '.github'];
function projectFiles(root) {
  const files = [];
  const walk = relative => {
    const path = join(root, relative);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${next}`);
      if (entry.isDirectory()) walk(next); else if (entry.isFile()) files.push(next);
    }
  };
  for (const path of roots) {
    if (!existsSync(join(root, path))) continue;
    if (['src', 'test', 'examples', 'adapters', 'scripts', 'docs', '.github'].includes(path)) walk(path); else files.push(path);
  }
  // This is an allowlist, NOT a general secret scanner; review your files before publication.
  return files.filter(path => !path.split('/').some(p => p === 'node_modules' || p === 'dist' || p === '.git' || (p.startsWith('.env') && p !== '.env.example')) && !/\.(jsonl|log)$/.test(path));
}
export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log('Usage: node scripts/publish-github.mjs [--owner LOGIN] [--name REPO] [--public] [--dry-run]'); return;
  }
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (options.dryRun) {
    console.log(JSON.stringify({ target: `${options.owner}/${options.name}`, visibility: options.visibility, command: ['gh', ...createArgs(options, directory)], note: 'Preview only. No authentication, GitHub request, git init, commit or push performed.' }, null, 2)); return;
  }
  const run = (command, args, required = true) => {
    const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    if (required && (result.error || result.status !== 0)) throw new Error(`${command} ${args.join(' ')} failed. ${result.error?.message ?? result.stderr?.trim() ?? ''}`);
    return result;
  };
  run('git', ['--version']);
  run('gh', ['--version']);
  const identity = run('gh', ['api', 'user', '--jq', '.login'], false);
  if (identity.status !== 0) throw new Error('GitHub CLI is not authenticated. Run gh auth login locally, then retry. Never paste your token into chat.');
  if (identity.stdout.trim().toLowerCase() !== options.owner.toLowerCase()) throw new Error('Authenticated GitHub user does not match --owner; no repository was created.');
  const target = `${options.owner}/${options.name}`;
  if (run('gh', ['repo', 'view', target, '--json', 'nameWithOwner'], false).status === 0) throw new Error('Target repository already exists. This script does not overwrite existing repositories.');
  const top = run('git', ['rev-parse', '--show-toplevel'], false);
  if (top.status === 0) {
    const samePath = process.platform === 'win32'
      ? realpathSync(top.stdout.trim()).toLowerCase() === realpathSync(directory).toLowerCase()
      : realpathSync(top.stdout.trim()) === realpathSync(directory);
    if (!samePath) throw new Error('Project is nested in another Git repository; refusing to modify the parent repository.');
    if (run('git', ['remote']).stdout.trim()) throw new Error('An existing Git remote is configured. Inspect it before publishing.');
    if (run('git', ['rev-parse', '--verify', 'HEAD'], false).status === 0) throw new Error('Local commit history already exists. Review it, then use the documented gh repo create command manually; no automatic history push.');
  }
  const files = projectFiles(directory);
  if (!files.length || !readFileSync(join(directory, 'package.json'), 'utf8').includes('reflexmesh')) throw new Error('Not the expected project directory.');
  const compiler = join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(compiler)) throw new Error('Install the pinned build dependency first: npm ci --ignore-scripts');
  run(process.execPath, [compiler, '-p', 'tsconfig.json']);
  run(process.execPath, ['--test', ...readdirSync(join(directory, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`)]);
  if (top.status !== 0) run('git', ['init', '--initial-branch=main']);
  if (run('git', ['var', 'GIT_AUTHOR_IDENT'], false).status !== 0) throw new Error('Set local git config user.name and user.email, then retry.');
  const staged = run('git', ['diff', '--cached', '--name-only']).stdout.trim().split('\n').filter(Boolean);
  if (staged.some(path => !files.includes(path))) throw new Error('Unexpected staged files; review and unstage them before publishing.');
  run('git', ['add', '--', ...files]);
  run('git', ['commit', '-m', 'feat: bootstrap ReflexMesh semantic decision runtime']);
  const create = run('gh', createArgs(options, directory), false);
  if (create.status !== 0) throw new Error(`Creation or push failed. A local commit or remote may now exist; inspect both before retrying. ${create.stderr?.trim() ?? ''}`);
  const verified = run('gh', ['repo', 'view', target, '--json', 'url,isPrivate,defaultBranchRef']);
  console.log('Repository created and initial push completed:');
  console.log(verified.stdout.trim());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Publication failed'); process.exitCode = 1; }
}
