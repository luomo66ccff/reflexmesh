import { readFileSync } from 'node:fs';
import { compactLedger } from '../../adapters/compaction-database.mjs';

const [source, backup, expectedFile, gate] = process.argv.slice(2);
try {
  const expectedSnapshot = JSON.parse(readFileSync(expectedFile, 'utf8'));
  await compactLedger(source, { expectedSnapshot, backupPath: backup,
    onStage: async stage => {
      if (stage === gate) {
        process.stdout.write(`${stage}\n`);
        setInterval(() => {}, 60_000);
        await new Promise(() => {}); // Parent owns this child and kills it at the exact stage barrier.
      }
    },
  });
  process.stdout.write('completed\n');
} catch (error) {
  process.stdout.write(`${String(error?.code).startsWith('compaction_') ? error.code : 'unexpected_error'}\n`);
  process.exitCode = 1;
}
