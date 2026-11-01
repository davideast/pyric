// The recorder's Node layer, in a real Node process. A sink preload loads
// before the recorder and sends anything the recorder lets through to a local
// port, so these tests never reach the network even if the recorder breaks.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeNetworkEvent } from './recorder/network-record.ts';
import { RECORDER_PRELOAD } from './scratch.ts';

const SINK = fileURLToPath(new URL('./fixtures/sink-preload.mjs', import.meta.url));
const PROBES = fileURLToPath(new URL('./fixtures/egress-probes.mjs', import.meta.url));

interface ProbeRun {
  outcomes: Record<string, string>;
  workers: Record<string, unknown>;
  record: NodeNetworkEvent[];
  stderr: string;
}

function runProbes(): ProbeRun {
  const log = join(mkdtempSync(join(tmpdir(), 'builders-recorder-')), 'network.jsonl');
  const result = spawnSync('node', [PROBES], {
    env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${SINK} --import ${RECORDER_PRELOAD}`, PYRIC_BUILDER_NETWORK_LOG: log },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`the probes exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  const parsed = JSON.parse(line) as Pick<ProbeRun, 'outcomes' | 'workers'>;
  const record = readFileSync(log, 'utf8').trim().split('\n').map((text) => JSON.parse(text) as NodeNetworkEvent);
  return { ...parsed, record, stderr: result.stderr };
}

const run = runProbes();

describe('node-egress.mjs', () => {
  test('refuses every probe with its own error code', () => {
    for (const [probe, outcome] of Object.entries(run.outcomes)) {
      expect({ probe, outcome }).toEqual({ probe, outcome: 'PYRIC_BUILDER_REFUSED' });
    }
  });

  test('nothing reached the sink: each refusal came before the connect or the query', () => {
    expect(run.stderr).not.toContain('SINK ESCAPED');
  });

  test('records each refused host, with what it did', () => {
    const refused = new Set(run.record.filter((event) => event.action === 'refused').map((event) => event.host));
    for (const host of ['firestore.googleapis.com', 'metadata.google.internal', '169.254.169.254', 'firebaserules.googleapis.com', 'oauth2.googleapis.com', 'identitytoolkit.googleapis.com', 'firebaseio.com']) {
      expect(refused.has(host)).toBe(true);
    }
  });

  test('records a request when it is created, before its socket is refused', () => {
    const fetchEvents = run.record.filter((event) => event.host === 'firestore.googleapis.com').map((event) => `${event.kind} ${event.action}`);
    expect(fetchEvents.slice(0, 2)).toEqual(['request recorded', 'connect refused']);
  });

  test('marks a Google host outside pyric’s catalog as a catalog gap', () => {
    const gap = run.record.find((event) => event.host === 'oauth2.googleapis.com');
    expect(gap).toMatchObject({ google: true, catalogGap: true });
    const listed = run.record.find((event) => event.host === 'firestore.googleapis.com');
    expect(listed).toMatchObject({ google: true, catalogGap: false, service: 'Cloud Firestore' });
  });

  test('says why on stderr, so a builder can tell the recorder from pyric', () => {
    expect(run.stderr).toContain('[pyric-builders recorder] refused a socket connect to 169.254.169.254');
  });

  test('loads into worker threads Node would skip it in', () => {
    expect(run.workers).toEqual({ 'CommonJS eval': true, 'own execArgv': true });
  });

  test('a process without a network log does not start', () => {
    const result = spawnSync('node', ['-e', 'console.log("ran")'], {
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--import ${RECORDER_PRELOAD}` },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('ran');
    expect(result.stderr).toContain('PYRIC_BUILDER_NETWORK_LOG is not set');
  });
});
