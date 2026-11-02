/**
 * The inside half of the way into a sandbox: listens on a Unix socket in the
 * run root and pipes each connection to a port on the sandbox's loopback.
 *
 *   node test/builders/factory/socket-bridge.ts <socket> <port>
 *
 * The host half (`served-process.ts`) listens on a TCP port and pipes each
 * connection to the socket. Nothing in the sandbox can open a connection out
 * through it: it only accepts. Imports only Node, since it runs inside.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';

export function pipeBoth(a: Socket, b: Socket): void {
  a.pipe(b);
  b.pipe(a);
  const end = () => { a.destroy(); b.destroy(); };
  a.once('error', end);
  b.once('error', end);
  a.once('close', end);
  b.once('close', end);
}

const isEntryPoint = process.argv[1] === new URL(import.meta.url).pathname;
if (isEntryPoint) {
  const [socketPath, port] = process.argv.slice(2);
  if (socketPath === undefined || port === undefined) throw new Error('usage: node socket-bridge.ts <socket> <port>');
  // A socket file left by an earlier sandbox; this one is ours now.
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((client) => pipeBoth(client, connect(Number(port), '127.0.0.1')));
  server.listen(socketPath, () => console.log(JSON.stringify({ listening: socketPath })));
}
