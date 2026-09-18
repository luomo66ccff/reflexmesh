import { readFileSync } from 'node:fs';
import { SqliteKernel } from '../../adapters/sqlite-kernel.mjs';
const [path,file,id] = process.argv.slice(2), k = new SqliteKernel(path);
const review = { ...JSON.parse(readFileSync(file,'utf8')), id };
process.send({ ready: true });
process.once('message', () => {
  try { k.reviewRecovery(review); process.send({ status: 'accepted' }); }
  catch (e) { process.send({ status: /epoch conflict/.test(e.message) ? 'conflict' : 'unexpected' }); }
  finally { k.close(); process.disconnect(); }
});
