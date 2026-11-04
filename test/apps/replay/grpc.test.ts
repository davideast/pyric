/**
 * The Node build of the real `firebase` SDK, from this checkout's
 * node_modules, signs in, reads, listens and writes against the replay
 * server over gRPC, in a `node` process of its own (`node-client.mjs`). The
 * SDK's emulator connectors point it at the server, as an app's config does.
 * The server runs under Node too (`process.ts`), whose HTTP/2 server carries
 * grpc-js streams.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay'`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { timestampJson, timestampProto } from './grpc.ts';
import { receivedBy, startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';

const ROOT = resolve(import.meta.dir, '../../..');
let server: ReplayProcess;

beforeAll(async () => {
  server = await startReplayProcess([join(import.meta.dir, 'fixtures', 'rooms.json')], ROOT);
});

afterAll(async () => {
  await server.stop();
});

test('times convert between RFC 3339 and Timestamp both ways', () => {
  expect(timestampProto('2026-11-01T08:00:00.000001Z')).toEqual({ seconds: '1793520000', nanos: 1000 });
  expect(timestampJson({ seconds: '1793520000', nanos: 1000 })).toBe('2026-11-01T08:00:00.000001Z');
  expect(timestampJson({ seconds: '1793520000', nanos: 7 })).toBe('2026-11-01T08:00:00.000000007Z');
  expect(timestampProto('2026-11-01T08:00:00Z')).toEqual({ seconds: '1793520000', nanos: 0 });
});

/** Runs a node script to exit; the replay server answers it from this process meanwhile. */
function runNode(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('node', args, { timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part: Buffer) => { stdout += part.toString(); });
    child.stderr.on('data', (part: Buffer) => { stderr += part.toString(); });
    child.on('close', () => done({ stdout, stderr }));
  });
}

test('the Node SDK reads, is denied, listens and writes over gRPC as the signed-in account', async () => {
  const run = await runNode([join(import.meta.dir, 'node-client.mjs'), server.origin, server.grpc!]);
  const line = run.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
  expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
    uid: 'user-reader',
    read: { exists: true, data: { name: 'Lobby', open: true, seats: 12 }, fromCache: false },
    denied: 'permission-denied',
    listened: [['lobby'], ['garden', 'lobby']],
    deniedWrite: 'permission-denied',
  });
  expect(await unmatchedBy(server.origin)).toEqual([]);
  const streams = (await receivedBy(server.origin)).filter((entry) => entry.rpc !== 'auth');
  expect(streams.length).toBeGreaterThan(0);
  expect(streams.every((entry) => entry.as === 'user-reader')).toBe(true);
}, 90_000);
