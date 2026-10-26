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
 *
 * The listener binds `requested`, or a port the kernel chooses when it is 0.
 */
export async function blackholedPort(requested = 0): Promise<BlackholedPort> {
  const listener = spawn(
    'node',
    [
      '-e',
      `const server = require('node:net').createServer();
server.listen({ port: Number(process.argv[1]), host: '127.0.0.1', backlog: 1 }, () => {
  process.stdout.write(server.address().port + '\\n');
  // Bounded, so a listener orphaned by a crashed test frees its port.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  process.exit(0);
});`,
      String(requested),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    listener.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim())));
    listener.once('error', reject);
    listener.once('exit', (code) => reject(new Error(`the blackhole listener exited with code ${code} before binding port ${requested}`)));
  });
  const fillers: Socket[] = [];
  const close = (): void => {
    for (const filler of fillers) filler.destroy();
    listener.kill();
  };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const filler = connect(port, '127.0.0.1');
    // Errors after the queue fills (the destroy at close) are expected.
    filler.on('error', () => {});
    fillers.push(filler);
    // Only a connect that neither completes nor fails is dropped. A refusal
    // means this kernel resets on overflow, and the port is not blackholed.
    const connected = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 250);
      filler.once('connect', () => {
        clearTimeout(timer);
        resolve(true);
      });
      filler.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }).catch((error: unknown) => {
      close();
      throw error;
    });
    if (!connected) return { port, close };
  }
  close();
  throw new Error(`the accept queue on port ${port} never filled`);
}
