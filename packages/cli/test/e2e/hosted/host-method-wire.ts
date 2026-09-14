import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { z } from 'zod';

/** Real HTTP pipelining keeps all commands on one admitted connection. */
export async function openMethodWire(baseUrl: string, projectDir: string, onData?: (chunk: string) => void) {
  const url = new URL(baseUrl);
  const response = await fetch(new URL('/__pyric/health', url));
  const health = z.object({ instanceId: z.string() }).parse(await response.json());
  const socket = connect(Number(url.port), url.hostname);
  let received = '';
  let failure: Error | undefined;
  socket.setEncoding('utf8');
  const receive = onData ?? ((chunk: string) => { received += chunk; });
  socket.on('data', receive);
  socket.on('error', error => { failure = error; });
  await once(socket, 'connect');
  const ended = new Promise<void>(resolve => { socket.once('close', () => resolve()); });
  function encodeCommand(key: string, args: Record<string, unknown>) {
    return JSON.stringify({ instanceId: health.instanceId, projectDir: realpathSync(projectDir), key, args });
  }
  function markPipeline(connection: 'keep-alive' | 'close') {
    // The platform HTTP diagnostic in the host preload observes this marker
    // after the parser has delivered all preceding request bodies.
    socket.write(`GET /__pyric/health HTTP/1.1\r\nHost: ${url.host}\r\nX-Pyric-Test-Pipeline-End: 1\r\nConnection: ${connection}\r\n\r\n`);
  }
  return {
    received: () => received,
    byteLength(key: string, args: Record<string, unknown>) {
      return Buffer.byteLength(encodeCommand(key, args));
    },
    command(key: string, args: Record<string, unknown>) {
      const body = encodeCommand(key, args);
      socket.write(`POST /__pyric/hosted/method HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    },
    checkpoint() { markPipeline('keep-alive'); },
    finish() { markPipeline('close'); },
    async result() {
      await ended;
      const failed = failure !== undefined;
      if (failed) throw failure;
      return received;
    },
    async close() { socket.destroy(); await ended; },
  };
}
