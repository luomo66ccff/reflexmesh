import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HOST_VERSION = '0.1.2-rc.1';
const MANIFEST_LIMIT = 1024 * 1024;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGES = Object.freeze({
  dsh: HOST_VERSION, 'dsh-llm': HOST_VERSION, 'dsh-tools': HOST_VERSION,
  'dsh-agent': HOST_VERSION, 'dsh-agent-loop': HOST_VERSION,
  'dsh-session': HOST_VERSION, 'dsh-session-projection': HOST_VERSION,
  'dsh-system-prompt': HOST_VERSION, 'dsh-agent-default-model': HOST_VERSION,
  'dsh-headless': HOST_VERSION, cordis: '4.0.2',
  'cordis-plugin-loader': '1.0.3', 'cordis-plugin-timer': '1.1.4',
});

const publicVersion = value => {
  if (typeof value !== 'string' || value.length > 64) return 'unknown';
  const match = SEMVER.exec(value);
  if (!match || match[1]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return 'unknown';
  return value;
};
const regularFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

/** Inspect only explicitly named installed manifests and two CLI entry files. Never import host code. */
export function inspectAgentPackages(packageRoot) {
  let root;
  try { root = realpathSync(packageRoot); }
  catch { return { ok: false, reason: 'host_package_missing', hostVersion: 'unknown' }; }
  const sibling = dirname(root);
  let hostVersion = 'unknown';
  for (const [name, expectedVersion] of Object.entries(PACKAGES)) {
    const base = name === 'dsh' ? root : join(sibling, name);
    const manifestPath = join(base, 'package.json');
    let manifest;
    try {
      const stat = statSync(manifestPath);
      if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return { ok: false, reason: 'unsupported_package_layout', hostVersion };
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch { return { ok: false, reason: 'host_package_missing', hostVersion }; }
    if (name === 'dsh') hostVersion = publicVersion(manifest?.version);
    if (manifest?.name !== `@deepseek-ai/${name}` || manifest.version !== expectedVersion) {
      return { ok: false, reason: 'unsupported_host_version', hostVersion };
    }
  }
  if (!regularFile(join(root, 'lib', 'bin.js')) || !regularFile(join(sibling, 'dsh-headless', 'lib', 'startup.js'))) {
    return { ok: false, reason: 'unsupported_package_layout', hostVersion };
  }
  return { ok: true, root, hostVersion };
}
