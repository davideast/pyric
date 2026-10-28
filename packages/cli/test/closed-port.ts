import { createServer } from 'node:net';

/** A loopback port that refuses connections at once: bound, then closed.
 *  Port 1 is not safe for this; some networks drop it instead of refusing. */
export function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
