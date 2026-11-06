/**
 * Runs a replay server in a `node` process of its own, for a caller that
 * needs the gRPC streams: Bun's HTTP/2 server resets grpc-js streams
 * ("Received RST_STREAM with code 2 triggered by internal client error:
 * Protocol error"), so the gRPC side runs under Node.
 *
 *   node --experimental-transform-types test/apps/replay/serve.ts [--grpc <projectDir>] [--rtdb-capture <project>] [--storage-capture <project>] [--messaging-capture <project>] [--ai] [<recording.json>...]
 *
 * With `--rtdb-capture`, it also serves RTDB capture A (`rtdb-capture.ts`)
 * for `<project>`, converted when it starts. With `--storage-capture`, it
 * also serves Storage capture S (`storage-capture.ts`) for `<project>`, on its
 * default and second buckets. With `--messaging-capture`, it also serves
 * Messaging capture M (`messaging-capture.ts`) for `<project>`. With `--ai`, it also answers AI
 * Logic from the committed observations (`ai.ts`).
 * It prints one line, `REPLAY {"origin":...,"grpc":...}`, once it listens,
 * and serves what it saw on its own origin: `GET /__replay/received` and
 * `GET /__replay/unmatched`. `process.ts` starts it and reads them.
 */
import { parseArgs } from 'node:util';
import { readRecording } from './format.ts';
import { loadCaptureM } from './messaging-capture.ts';
import { loadCaptureA } from './rtdb-capture.ts';
import { startReplayServer } from './server.ts';
import { loadCaptureS } from './storage-capture.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { grpc: { type: 'string' }, 'rtdb-capture': { type: 'string' }, 'storage-capture': { type: 'string' }, 'messaging-capture': { type: 'string' }, ai: { type: 'boolean' } },
  allowPositionals: true,
});
const captureProject = values['rtdb-capture'];
const storageProject = values['storage-capture'];
const messagingProject = values['messaging-capture'];
if (positionals.length === 0 && !captureProject && !storageProject && !messagingProject && !values.ai) {
  console.error('usage: node --experimental-transform-types test/apps/replay/serve.ts [--grpc <projectDir>] [--rtdb-capture <project>] [--storage-capture <project>] [--messaging-capture <project>] [--ai] [<recording.json>...]');
  process.exit(2);
}

const recordings = positionals.map((path) => readRecording(path));
if (captureProject) recordings.push(loadCaptureA(captureProject));
if (storageProject) recordings.push(loadCaptureS(storageProject));
if (messagingProject) recordings.push(loadCaptureM(messagingProject));
const server = await startReplayServer(recordings, {
  ...(values.grpc ? { grpc: { projectDir: values.grpc } } : {}),
  ...(values.ai ? { ai: true } : {}),
});
console.log(`REPLAY ${JSON.stringify({ origin: server.origin, grpc: server.grpc?.host ?? null })}`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
