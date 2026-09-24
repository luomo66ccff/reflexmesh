// Each admitted host revision needs its own installed-CLI fixture validation.
export const SUPPORTED_CLAUDE_VERSIONS = Object.freeze(['2.1.263', '2.1.280']);

export function supportedClaudeVersion(stdout) {
  if (typeof stdout !== 'string') return null;
  const label = stdout.trim();
  return SUPPORTED_CLAUDE_VERSIONS.find(version => label === `${version} (Claude Code)`) ?? null;
}
