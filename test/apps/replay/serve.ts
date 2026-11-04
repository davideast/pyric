/**
 * Runs a replay server in a `node` process of its own, for a caller that
 * needs the gRPC streams: Bun's HTTP/2 server resets grpc-js streams
 * ("Received RST_STREAM with code 2 triggered by internal client error:
 * Protocol error"), so the gRPC side runs under Node.
 *
 *   node --experimental-transform-types test/apps/replay/serve.ts [--grpc <projectDir>] <recording.json>...
 *
 * It prints one line, `REPLAY {"origin":...,"grpc":...}`, once it listens,
 * and serves what it saw on its own origin: `GET /__replay/received` and
 * `GET /__replay/unmatched`. `process.ts` starts it and reads them.
 */
import { parseArgs } from 'node:util';
import { readRecording } from './format.ts';
import { startReplayServer } from './server.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { grpc: { type: 'string' } },
  allowPositionals: true,
});
if (positionals.length === 0) {
  console.error('usage: node --experimental-transform-types test/apps/replay/serve.ts [--grpc <projectDir>] <recording.json>...');
  process.exit(2);
}

const server = await startReplayServer(positionals.map((path) => readRecording(path)), {
  ...(values.grpc ? { grpc: { projectDir: values.grpc } } : {}),
});
console.log(`REPLAY ${JSON.stringify({ origin: server.origin, grpc: server.grpc?.host ?? null })}`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
