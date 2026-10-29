// The resolver inside a run's network namespace. The namespace has only
// loopback, and its /etc/resolv.conf names 127.0.0.1, so every DNS query a
// process sends through the system resolver comes here, whatever runtime
// sent it: Bun, curl, a Go binary, a Node process the preload missed. Each
// query is recorded as one line of the run's network record and answered
// NXDOMAIN. Names in /etc/hosts, such as localhost, never reach it.
//
// It is also the process that holds the namespace open: the harness starts it
// as `unshare -rnm sh -c '... && exec node dns-log.mjs'` and enters the
// namespace through its pid. It prints `{"ready":true}` once it listens, and
// exits when its stdin closes or on SIGTERM.
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyHost } from './google-hosts.ts';

const HEADER_BYTES = 12;
const QUESTION_TAIL_BYTES = 4;
const RCODE_NXDOMAIN = 3;
const QUERY_TYPES = new Map([[1, 'A'], [2, 'NS'], [5, 'CNAME'], [6, 'SOA'], [12, 'PTR'], [15, 'MX'], [16, 'TXT'], [28, 'AAAA'], [33, 'SRV'], [64, 'SVCB'], [65, 'HTTPS'], [255, 'ANY']]);

/** The first question of a DNS query, and where it ends, or null for anything malformed. */
export function parseQuestion(message) {
  if (message.length < HEADER_BYTES + QUESTION_TAIL_BYTES + 1) return null;
  const labels = [];
  let offset = HEADER_BYTES;
  for (;;) {
    if (offset >= message.length) return null;
    const length = message[offset];
    offset += 1;
    if (length === 0) break;
    const isPointerOrLong = length > 63;
    if (isPointerOrLong || offset + length > message.length) return null;
    labels.push(message.toString('latin1', offset, offset + length));
    offset += length;
  }
  if (offset + QUESTION_TAIL_BYTES > message.length) return null;
  const type = message.readUInt16BE(offset);
  return { id: message.readUInt16BE(0), name: labels.join('.'), type: QUERY_TYPES.get(type) ?? String(type), end: offset + QUESTION_TAIL_BYTES };
}

/** An NXDOMAIN answer to `message`: its header and question, with no records. */
export function nxdomainFor(message, question) {
  const answer = Buffer.from(message.subarray(0, question.end));
  const opcodeAndRd = message[2] & 0b0111_1001;
  answer[2] = 0b1000_0000 | opcodeAndRd;
  answer[3] = 0b1000_0000 | RCODE_NXDOMAIN;
  answer.writeUInt16BE(1, 4);
  answer.writeUInt16BE(0, 6);
  answer.writeUInt16BE(0, 8);
  answer.writeUInt16BE(0, 10);
  return answer;
}

/** The record line for one query. */
export function queryEvent(question, time = new Date()) {
  const verdict = classifyHost(question.name);
  return {
    time: time.toISOString(),
    layer: 'namespace',
    kind: 'dns',
    via: 'resolver',
    queryType: question.type,
    host: verdict.host,
    google: verdict.google,
    catalogGap: verdict.catalogGap,
    metadata: verdict.metadata,
    ...(verdict.service ? { service: verdict.service } : {}),
    action: 'refused',
  };
}

function serve(logPath) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (message, peer) => {
    const question = parseQuestion(message);
    if (question === null) return;
    appendFileSync(logPath, `${JSON.stringify(queryEvent(question))}\n`);
    socket.send(nxdomainFor(message, question), peer.port, peer.address);
  });
  socket.bind(53, '127.0.0.1', () => console.log(JSON.stringify({ ready: true })));
  const stop = () => socket.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  process.stdin.resume();
}

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const logPath = process.env.PYRIC_BUILDER_NETWORK_LOG;
  if (!logPath) throw new Error('PYRIC_BUILDER_NETWORK_LOG is not set');
  serve(logPath);
}
