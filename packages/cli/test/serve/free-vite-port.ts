import { createServer } from 'node:net';

/**
 * Allocates a genuinely free loopback TCP port (`> 0`) for Vite test servers.
 *
 * Vite treats `server.port: 0` as unset (`options.port || 5173`), which causes
 * `server.listen()` under `bun test` to hang when another process is already
 * listening on wildcard `::` port 5173.
 */
export function allocateFreeVitePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const addr = probe.address();
      if (addr === null || typeof addr === 'string') {
        probe.close(() => reject(new Error('allocateFreeVitePort: expected numeric TCP address')));
        return;
      }
      const { port } = addr;
      probe.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolvePort(port);
      });
    });
  });
}
