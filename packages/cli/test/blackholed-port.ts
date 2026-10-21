import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';

/** A loopback port whose connects never complete and never refuse. */
export interface BlackholedPort {
  readonly port: number;
  close(): void;
}

/**
 * A listener that never accepts, with its accept queue kept full.
 *
 * A Node child listens with a backlog of one and then blocks its thread, so
 * it never calls accept. The kernel completes handshakes into the accept
 * queue until it is full, then drops every further SYN, so a new connect
 * stays in SYN-SENT until the client gives up. That is how a closed port
 * behaves under WSL mirrored networking, reproduced on any Linux.
 */
export async function blackholedPort(): Promise<BlackholedPort> {
  const listener = spawn(
    'node',
    [
      '-e',
      `const server = require('node:net').createServer();
server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
  process.stdout.write(server.address().port + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    listener.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    listener.once('error', reject);
  });
  const fillers: Socket[] = [];
  const close = (): void => {
    for (const filler of fillers) filler.destroy();
    listener.kill();
  };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const filler = connect(port, '127.0.0.1');
    filler.on('error', () => {});
    fillers.push(filler);
    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 250);
      filler.once('connect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!connected) return { port, close };
  }
  close();
  throw new Error(`the accept queue on port ${port} never filled`);
}
