import { DatabaseSync } from 'node:sqlite';

// Test-only process that keeps an exclusive startup lock until explicitly released.
const db = new DatabaseSync(process.argv[2]);
db.exec('BEGIN EXCLUSIVE');
process.once('message', () => {
  db.exec('ROLLBACK');
  db.close();
  process.send({ released: true }, () => process.disconnect());
});
process.send({ ready: true });
