/**
 * The inside half of a way between sandboxes, run inside one:
 *
 *   node test/builders/factory/socket-bridge.ts unix-to-tcp <socket> <port>
 *       Listens on a Unix socket and pipes each connection to a port on the
 *       sandbox's loopback: how Studio's sandbox is reached.
 *   node test/builders/factory/socket-bridge.ts tcp-to-unix <port> <socket>
 *       Listens on a port of the sandbox's loopback and pipes each connection
 *       to a Unix socket the host listens on: how the walk sandbox reaches
 *       Studio at 127.0.0.1.
 *
 * The socket path is relative to the working directory, so it fits the
 * kernel's 108 bytes however deep the sandbox's root is. The host half is
 * `relay.ts`. Imports only Node, since it runs inside.
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

function unixToTcp(socketPath: string, port: number): void {
  // A socket file left by an earlier run of this bridge in the same sandbox.
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((client) => pipeBoth(client, connect(port, '127.0.0.1')));
  server.listen(socketPath, () => console.log(JSON.stringify({ listening: socketPath })));
}

function tcpToUnix(port: number, socketPath: string): void {
  const server = createServer((client) => pipeBoth(client, connect(socketPath)));
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ listening: port })));
}

const isEntryPoint = process.argv[1] === new URL(import.meta.url).pathname;
if (isEntryPoint) {
  const [mode, first, second] = process.argv.slice(2);
  const usage = 'usage: node socket-bridge.ts unix-to-tcp <socket> <port> | tcp-to-unix <port> <socket>';
  if (first === undefined || second === undefined) throw new Error(usage);
  if (mode === 'unix-to-tcp') unixToTcp(first, Number(second));
  else if (mode === 'tcp-to-unix') tcpToUnix(Number(first), second);
  else throw new Error(usage);
}
