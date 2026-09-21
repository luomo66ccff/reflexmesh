import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const nonlocalPath = value => {
  const normalized = value.replaceAll('/', '\\');
  return normalized.startsWith('\\\\') || /^\\(?:\?\?|Device|GLOBAL\?\?)\\/i.test(normalized);
};
const driveQualified = value => /^[a-z]:[\\/]/i.test(value);

/** Static explicit-file check, not version, executable integrity, or load verification. */
export function inspectExplicitClaudeExecutable(path, { platform = process.platform, lstat = lstatSync } = {}) {
  const absent = reason => ({ ok: false, reason, hostVersion: 'unverified' });
  if (platform !== 'win32') return absent('unsupported_host_platform');
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096
    || CONTROL.test(path) || nonlocalPath(path) || !win32.isAbsolute(path)
    || !driveQualified(path) || /[$%`]/.test(path)) return absent('invalid_executable_path');
  if (win32.extname(path).toLowerCase() !== '.exe') return absent('unsupported_executable_layout');
  try {
    if (!lstat(path).isFile()) return absent('unsupported_executable_layout');
  } catch { return absent('host_executable_missing'); }
  return { ok: true, status: 'explicit_executable_present', hostVersion: 'unverified' };
}
