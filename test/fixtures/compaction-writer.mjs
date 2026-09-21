import { DatabaseSync } from 'node:sqlite';

let db;
try {
  db = new DatabaseSync(process.argv[2]);
  db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  db.prepare('INSERT INTO packs(id,version,digest,body) VALUES(?,?,?,?)')
    .run('unexpected-writer', '1', 'fixture', '{}');
  db.exec('COMMIT');
  process.stdout.write('wrote\n');
} catch (error) {
  process.stdout.write(/busy|locked/i.test(String(error?.message)) ? 'busy\n' : 'error\n');
} finally { try { db?.close(); } catch {} }
