// Sends one Messages request nested 100,000 levels deep to a model forwarder
// in this process, and prints what came back: the status line and the
// record's lines, as one JSON line. model-forwarder.test.ts runs it under
// Node and under Bun, since the two runtimes failed differently on a body
// this deep (Bun left the client unanswered, Node crashed). The upstream is
// a closed loopback port, and the request is refused before it would be used.
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChannelRecord } from '../model-channel.ts';
import { startModelForwarder } from '../model-forwarder.ts';
import { roundMeter } from '../model-meter.ts';

const DEPTH = 100_000;

const dir = mkdtempSync(join(tmpdir(), 'builders-deep-body-'));
const record = join(dir, 'channel.jsonl');
writeFileSync(record, '');
const socketPath = join(dir, 'f.sock');
const forwarder = await startModelForwarder({
  socketPath, record, credential: 'made-up-credential-for-the-deep-body-fixture', meter: roundMeter(1).run(1),
  upstream: { host: '127.0.0.1', port: 9, tls: false },
});

const body = `{"model":"claude-haiku-5-5","max_tokens":1,"messages":${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}}`;
const answer = await new Promise<string>((resolve) => {
  let received = '';
  const socket = net.connect(socketPath, () => socket.write(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
  socket.on('data', (chunk) => { received += String(chunk); });
  socket.on('close', () => resolve(received));
  socket.on('error', () => resolve(received));
  socket.setTimeout(10_000, () => socket.destroy());
});

const lines = readChannelRecord(record).map((event) => ({ action: event.action, reason: event.reason, status: event.status }));
process.stdout.write(`${JSON.stringify({ statusLine: answer.split('\r\n')[0] ?? '', record: lines })}\n`);
await forwarder.close();
