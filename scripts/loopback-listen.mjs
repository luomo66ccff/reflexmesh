// https://fetch.spec.whatwg.org/#bad-port (checked 2026-09-22).
const blocked = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
  143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
  563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/** Let the OS avoid reserved ports, then reject Fetch-blocked assignments before publishing the listener. */
export async function listenLoopback(server, { choosePort = () => 0, attempts = 8 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) throw new Error('Invalid loopback attempts');
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = choosePort();
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port !== 0 && blocked.has(port)) throw new Error('Invalid loopback port');
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        try { server.listen(port, '127.0.0.1'); }
        catch (error) { server.removeListener('error', failed); failed(error); }
      });
    } catch (error) { if (error.code !== 'EADDRINUSE' || attempt === attempts - 1) throw error; else continue; }
    const address = server.address();
    const valid = address && typeof address === 'object' && address.address === '127.0.0.1'
      && Number.isSafeInteger(address.port) && address.port > 0 && address.port <= 65535;
    if (valid && !blocked.has(address.port)) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!valid) throw new Error('Invalid bound loopback address');
  }
  throw new Error('No Fetch-compatible loopback port available');
}
