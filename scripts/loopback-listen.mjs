import { randomInt } from 'node:crypto';

/** Fetch clients reject some OS-selected ports. Use the high private range, with bounded collision retries. */
export async function listenLoopback(server, { choosePort = () => randomInt(49152, 65536), attempts = 8 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) throw new Error('Invalid loopback attempts');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = choosePort();
    if (!Number.isSafeInteger(port) || port < 49152 || port > 65535) throw new Error('Invalid loopback port');
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        try { server.listen(port, '127.0.0.1'); }
        catch (error) { server.removeListener('error', failed); failed(error); }
      });
      return;
    } catch (error) { if (error.code !== 'EADDRINUSE' || attempt === attempts - 1) throw error; }
  }
}
