import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContractError } from '../dist/index.js';

const MAX_TEMPLATE_BYTES = 128 * 1024;

export async function writePackTemplate(outputPath, selected) {
  if (!selected) throw new ContractError('Unknown evidence key');
  if (typeof outputPath !== 'string' || !outputPath || outputPath.length > 1024
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(outputPath))
    throw new ContractError('A new --out FILE path is required');
  const path = resolve(outputPath);
  const bytes = Buffer.from(`${JSON.stringify(selected.pack, null, 2)}\n`, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_TEMPLATE_BYTES)
    throw new ContractError('Bound pack is too large for a replay candidate file');
  let file, created = false;
  try {
    file = await open(path, 'wx+', 0o600);
    created = true;
    await file.writeFile(bytes);
    await file.sync();
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== bytes.length) throw new Error('Write size mismatch');
    const readback = Buffer.alloc(bytes.length);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(readback, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== bytes.length || !readback.equals(bytes)) throw new Error('Write readback mismatch');
    return { kind: 'policy_pack_template', sourceKey: selected.sourceKey,
      sourcePackDigest: selected.sourcePackDigest, outputPath: path,
      bytesWritten: bytes.length, executionAllowed: false };
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ContractError('Destination already exists; choose a new file');
    if (created) throw new ContractError('Pack template write could not be verified; inspect the new file before continuing');
    throw new ContractError('Pack template destination is unavailable; check the parent directory');
  } finally {
    try { await file?.close(); }
    catch { throw new ContractError('Pack template close could not be verified; inspect the new file before continuing'); }
  }
}

export function formatPackTemplate(receipt) {
  return [
    'ReflexMesh pack template created from a bound recorded decision.',
    `New file: ${JSON.stringify(receipt.outputPath)}`,
    `Source key: ${JSON.stringify(receipt.sourceKey)}`,
    `Source pack digest: ${receipt.sourcePackDigest}`,
    'Review the full pack and destination-directory ACLs. Edit its version and rules before a what-if replay.',
    'No provider, tool, host permission or ledger record was changed; execution allowed: false.',
  ].join('\n') + '\n';
}
