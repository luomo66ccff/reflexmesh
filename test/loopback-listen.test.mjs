import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { listenLoopback } from '../scripts/loopback-listen.mjs';

test('synthetic loopback listener chooses a Fetch-compatible private port', async t => {
  const server = createServer((_req, res) => { res.end('synthetic'); });
  await listenLoopback(server); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1'); assert.ok(port >= 49152 && port <= 65535);
  const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(await response.text(), 'synthetic'); assert.equal(server.listenerCount('error'), 0);
});
test('port collisions retry a bounded number without stale startup listeners', async () => {
  const server = new EventEmitter(); let calls = 0;
  server.listen = (_port, host) => { assert.equal(host, '127.0.0.1'); calls++;
    queueMicrotask(() => { if (calls === 1) server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })); else server.emit('listening'); }); };
  await listenLoopback(server, { choosePort: () => 50000 }); assert.equal(calls, 2);
  assert.equal(server.listenerCount('error'), 0); assert.equal(server.listenerCount('listening'), 0);
  calls = 0; server.listen = () => { calls++; queueMicrotask(() => server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))); };
  await assert.rejects(listenLoopback(server, { choosePort: () => 50000, attempts: 2 })); assert.equal(calls, 2);
});
test('bad port candidates and non-collision failures never broaden listening', async () => {
  const server = new EventEmitter(); let calls = 0;
  server.listen = () => { calls++; queueMicrotask(() => server.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }))); };
  for (const port of [0, 6000, 10080, 65536, 50000.5]) await assert.rejects(listenLoopback(server, { choosePort: () => port }));
  assert.equal(calls, 0);
  await assert.rejects(listenLoopback(server, { choosePort: () => 50000 })); assert.equal(calls, 1);
  server.listen = () => { throw Object.assign(new Error('already listening'), { code: 'ERR_SERVER_ALREADY_LISTEN' }); };
  await assert.rejects(listenLoopback(server, { choosePort: () => 50000 }));
  assert.equal(server.listenerCount('error'), 0); assert.equal(server.listenerCount('listening'), 0);
});
