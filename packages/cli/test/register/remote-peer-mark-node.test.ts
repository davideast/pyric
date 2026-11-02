/**
 * The mark on Node's own HTTP parser, over a real socket. It runs under `node`
 * because `req.headersDistinct` is built lazily by Node from a header count
 * recorded at parse time, and `bun test` would use Bun's implementation. Needs
 * `dist/register/remote-peer-mark.js`: run `bun run build` first.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

const MARK_MODULE = fileURLToPath(new URL('../../dist/register/remote-peer-mark.js', import.meta.url));
const HEADER = 'x-pyric-remote-peer';

/**
 * The server answers with what a handler reads. Its clients connect over
 * loopback, so the socket reports a non-loopback peer: a machine need not have a
 * second address for this test, and the parser and the request are real.
 */
const SERVER = `
  import { createServer } from 'node:http';
  import { installRemotePeerMark } from ${JSON.stringify(MARK_MODULE)};
  installRemotePeerMark();
  const server = createServer((req, res) => {
    const raw = [];
    for (let name = 0; name < req.rawHeaders.length; name += 2) {
      if (req.rawHeaders[name].toLowerCase() === ${JSON.stringify(HEADER)}) raw.push(req.rawHeaders[name + 1]);
    }
    res.end(JSON.stringify({
      headers: req.headers[${JSON.stringify(HEADER)}],
      raw,
      distinct: req.headersDistinct[${JSON.stringify(HEADER)}],
      host: req.headersDistinct.host,
    }));
  });
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.1' });
  });
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

function startServer(): Promise<number> {
  const started = spawn('node', ['--input-type=module', '-e', SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
  child = started;
  return new Promise((resolve, reject) => {
    started.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    started.once('exit', (code) => reject(new Error(`the server exited with ${String(code)} before listening`)));
  });
}

/** Sends `copies` client copies of the header on one raw request and returns the response body. */
function ask(port: number, copies: number): Promise<string> {
  const forged = Array.from({ length: copies }, (_, index) => `${index % 2 === 0 ? 'X-Pyric-Remote-Peer' : HEADER}: 0\r\n`);
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: a.test\r\n${forged.join('')}Connection: close\r\n\r\n`);
    });
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { answer += chunk; });
    socket.on('end', () => resolve(answer.slice(answer.indexOf('\r\n\r\n') + 4)));
    socket.on('error', reject);
  });
}

describe('the remote peer mark on a real Node socket', () => {
  it('gives one value in every header view for zero to three client copies, and the process stays up', async () => {
    const port = await startServer();
    for (const copies of [0, 1, 2, 3]) {
      const body = await ask(port, copies);
      expect({ copies, seen: JSON.parse(body) as unknown }).toEqual({
        copies,
        seen: { headers: '1', raw: ['1'], distinct: ['1'], host: ['a.test'] },
      });
    }
    expect(child?.exitCode).toBeNull();
  });
});
