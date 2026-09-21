/** Schema 4 exists only after an explicit, backup-bound archival transaction. */
export const AUDIT_ARCHIVE_TABLE_SQL = Object.freeze({
  audit_archive_batches: `CREATE TABLE audit_archive_batches (
    id TEXT PRIMARY KEY,
    previous_id TEXT UNIQUE REFERENCES audit_archive_batches(id),
    archive_sha256 TEXT NOT NULL,
    archive_bytes INTEGER NOT NULL CHECK(archive_bytes>0),
    source_schema_version INTEGER NOT NULL CHECK(source_schema_version IN(3,4)),
    source_logical_digest TEXT NOT NULL,
    cutoff_at INTEGER NOT NULL,
    highwater_seq INTEGER NOT NULL,
    row_count INTEGER NOT NULL CHECK(row_count>0),
    audit_digest TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  ) STRICT`,
  audit_archive_coverage: `CREATE TABLE audit_archive_coverage (
    run_key TEXT NOT NULL REFERENCES runs(key),
    batch_id TEXT NOT NULL REFERENCES audit_archive_batches(id),
    row_count INTEGER NOT NULL CHECK(row_count>0),
    min_seq INTEGER NOT NULL,
    max_seq INTEGER NOT NULL,
    audit_digest TEXT NOT NULL,
    PRIMARY KEY(run_key,batch_id)
  ) STRICT`,
});

export const AUDIT_ARCHIVE_COLUMNS = Object.freeze({
  audit_archive_batches: Object.freeze(['id:TEXT:1:1', 'previous_id:TEXT:0:0',
    'archive_sha256:TEXT:1:0', 'archive_bytes:INTEGER:1:0', 'source_schema_version:INTEGER:1:0',
    'source_logical_digest:TEXT:1:0', 'cutoff_at:INTEGER:1:0', 'highwater_seq:INTEGER:1:0',
    'row_count:INTEGER:1:0', 'audit_digest:TEXT:1:0', 'committed_at:INTEGER:1:0']),
  audit_archive_coverage: Object.freeze(['run_key:TEXT:1:1', 'batch_id:TEXT:1:2',
    'row_count:INTEGER:1:0', 'min_seq:INTEGER:1:0', 'max_seq:INTEGER:1:0', 'audit_digest:TEXT:1:0']),
});

const HASH = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
export class AuditArchiveSchemaError extends Error {
  constructor() { super('Invalid audit archive metadata'); this.name = 'AuditArchiveSchemaError'; }
}
const check = value => { if (!value) throw new AuditArchiveSchemaError(); };
function count(db, sql, ...params) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const result = statement.get(...params)?.count;
  check(typeof result === 'bigint' && result >= 0n && result <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(result);
}
function validKey(bytes) {
  check(bytes instanceof Uint8Array);
  let key;
  try { key = decoder.decode(bytes); } catch { throw new AuditArchiveSchemaError(); }
  check(key.length > 0 && key.length <= 1024
    && Buffer.from(key, 'utf8').equals(Buffer.from(bytes)));
}

/** Validates one linear metadata chain and every batch's coverage sum; no raw audit body reads. */
export function inspectAuditArchiveMetadata(db, version) {
  if (version === 3) return Object.freeze({ tip: null, batchCount: 0 });
  check(version === 4);
  const batchCount = count(db, 'SELECT COUNT(*) AS count FROM audit_archive_batches');
  const coverageCount = count(db, 'SELECT COUNT(*) AS count FROM audit_archive_coverage');
  if (batchCount === 0) {
    check(coverageCount === 0);
    return Object.freeze({ tip: null, batchCount });
  }
  check(count(db, 'SELECT COUNT(*) AS count FROM audit_archive_batches WHERE previous_id IS NULL') === 1);
  const tips = db.prepare(`SELECT b.id FROM audit_archive_batches b
    WHERE NOT EXISTS (SELECT 1 FROM audit_archive_batches next WHERE next.previous_id=b.id) LIMIT 2`).all();
  check(tips.length === 1 && HASH.test(tips[0].id));
  const tip = tips[0].id;
  check(count(db, `WITH RECURSIVE chain(id,previous_id) AS (
    SELECT id,previous_id FROM audit_archive_batches WHERE id=?
    UNION SELECT b.id,b.previous_id FROM audit_archive_batches b JOIN chain c ON b.id=c.previous_id
  ) SELECT COUNT(*) AS count FROM chain`, tip) === batchCount);
  const batches = db.prepare(`SELECT b.*,COALESCE(SUM(c.row_count),0) AS covered
    FROM audit_archive_batches b LEFT JOIN audit_archive_coverage c ON c.batch_id=b.id
    GROUP BY b.id`);
  batches.setReadBigInts(true);
  const chain = new Map();
  for (const row of batches.iterate()) {
    check(HASH.test(row.id) && (row.previous_id === null || HASH.test(row.previous_id))
      && HASH.test(row.archive_sha256) && HASH.test(row.source_logical_digest)
      && HASH.test(row.audit_digest) && (row.source_schema_version === 3n || row.source_schema_version === 4n)
      && typeof row.archive_bytes === 'bigint' && row.archive_bytes > 0n
      && row.archive_bytes <= BigInt(Number.MAX_SAFE_INTEGER)
      && typeof row.cutoff_at === 'bigint' && row.cutoff_at >= 0n
      && row.cutoff_at <= BigInt(Number.MAX_SAFE_INTEGER)
      && typeof row.highwater_seq === 'bigint' && row.highwater_seq > 0n
      && typeof row.row_count === 'bigint' && row.row_count > 0n && row.row_count <= 10000n
      && row.covered === row.row_count && typeof row.committed_at === 'bigint'
      && row.committed_at >= 0n && row.committed_at <= BigInt(Number.MAX_SAFE_INTEGER));
    chain.set(row.id, { previousId: row.previous_id, sourceVersion: row.source_schema_version,
      highwater: row.highwater_seq });
  }
  let cursor = tip, laterHighwater = null;
  for (let visited = 0; visited < batchCount; visited++) {
    const item = chain.get(cursor);
    check(item !== undefined);
    check(laterHighwater === null || item.highwater <= laterHighwater);
    check(item.sourceVersion === (item.previousId === null ? 3n : 4n));
    laterHighwater = item.highwater;
    cursor = item.previousId;
  }
  check(cursor === null);
  const maxAudit = db.prepare('SELECT MAX(seq) AS seq FROM audit');
  maxAudit.setReadBigInts(true);
  const anchor = maxAudit.get()?.seq;
  check(typeof anchor === 'bigint' && anchor >= chain.get(tip).highwater);
  check(count(db, `SELECT COUNT(*) AS count FROM audit_archive_coverage c
    LEFT JOIN runs r ON r.key=c.run_key WHERE r.key IS NULL`) === 0);
  const coverages = db.prepare(`SELECT CAST(c.run_key AS BLOB) AS raw_key,c.row_count,c.min_seq,c.max_seq,
    c.audit_digest,b.highwater_seq FROM audit_archive_coverage c
    JOIN audit_archive_batches b ON b.id=c.batch_id`);
  coverages.setReadBigInts(true);
  let verified = 0;
  for (const row of coverages.iterate()) {
    validKey(row.raw_key);
    check(typeof row.row_count === 'bigint' && row.row_count > 0n && row.row_count <= 10000n
      && typeof row.min_seq === 'bigint' && row.min_seq > 0n
      && typeof row.max_seq === 'bigint' && row.max_seq >= row.min_seq
      && row.max_seq < row.highwater_seq && HASH.test(row.audit_digest));
    verified++;
  }
  check(verified === coverageCount);
  return Object.freeze({ tip, batchCount });
}
