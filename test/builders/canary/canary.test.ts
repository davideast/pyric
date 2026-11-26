// `runCanary` when the sandbox outlives SIGKILL (`stop()` returns
// `still-running`): even when every planted request was recorded and refused,
// the canary must fail (#1788).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EgressNamespace, SandboxStop } from '../namespace.ts';
import type { NetworkEvent } from '../recorder/network-record.ts';
import type { RunDirs } from '../scratch.ts';
import { runCanary } from './canary.ts';
import type { ExpectedPlants } from './plant-names.ts';
import type { PlantOutput } from './plant-phase.ts';
import type { CanaryVerdict } from './verdict.ts';

const SAVED_ENV = {
  PYRIC_BUILDERS_DIR: process.env.PYRIC_BUILDERS_DIR,
  PYRIC_HEAVY_RUN_DIR: process.env.PYRIC_HEAVY_RUN_DIR,
  PYRIC_HEAVY_RUN_SLOT: process.env.PYRIC_HEAVY_RUN_SLOT,
};

function restoreVar(name: keyof typeof SAVED_ENV): void {
  const value = SAVED_ENV[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreVar('PYRIC_BUILDERS_DIR');
  restoreVar('PYRIC_HEAVY_RUN_DIR');
  restoreVar('PYRIC_HEAVY_RUN_SLOT');
});

const TIME = '2026-11-25T00:00:00.000Z';
const LOCAL_URL = 'http://127.0.0.1:5173/local.txt';
const WS_URL = 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5';

const EXPECTED: ExpectedPlants = {
  node: ['fetch to Cloud Firestore'],
  browser: ['WebSocket to the Realtime Database'],
  unhooked: ['Bun fetch to oauth2'],
};

function stubNamespace(stopResult: SandboxStop): EgressNamespace {
  return {
    pid: 0,
    enter: (command, args) => ({ command, args: [...args] }),
    stop: async () => stopResult,
  };
}

function writePassingPlants(dirs: RunDirs): PlantOutput {
  const events: NetworkEvent[] = [
    { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node-plants.mjs', kind: 'plant', via: 'canary', plant: 'fetch to Cloud Firestore' },
    { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node-plants.mjs', kind: 'request', via: 'undici', host: 'firestore.googleapis.com', google: true, catalogGap: false, metadata: false, action: 'recorded' },
    { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node-plants.mjs', kind: 'connect', via: 'socket', host: 'firestore.googleapis.com', google: true, catalogGap: false, metadata: false, action: 'refused' },
    { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node-plants.mjs', kind: 'plant', via: 'canary', plant: 'local request' },
    { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node-plants.mjs', kind: 'connect', via: 'socket', host: '127.0.0.1', google: false, catalogGap: false, metadata: false, action: 'allowed' },
    { time: TIME, layer: 'browser', kind: 'request', via: 'netlog', source: 1, url: WS_URL, netError: -105, netErrorName: 'ERR_NAME_NOT_RESOLVED', host: 'demo-x-default-rtdb.firebaseio.com', google: true, catalogGap: false, metadata: false },
    { time: TIME, layer: 'browser', kind: 'request', via: 'netlog', source: 1, url: LOCAL_URL, netError: 0, host: '127.0.0.1', google: false, catalogGap: false, metadata: false },
    { time: TIME, layer: 'browser', kind: 'connect', via: 'netlog', source: 2, protocol: 'tcp', address: '127.0.0.1:5173', port: 5173, host: '127.0.0.1', google: false, catalogGap: false, metadata: false },
    { time: TIME, layer: 'namespace', kind: 'dns', via: 'resolver', queryType: 'A', host: 'oauth2.googleapis.com', google: true, catalogGap: true, metadata: false, action: 'refused' },
  ];
  writeFileSync(dirs.networkLog, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return {
    node: {
      plants: [{ name: 'fetch to Cloud Firestore', host: 'firestore.googleapis.com', outcome: 'failed: PYRIC_BUILDER_REFUSED' }],
      local: { name: 'local request', url: LOCAL_URL, outcome: 'succeeded' },
    },
    browser: {
      plants: [{ name: 'WebSocket to the Realtime Database', url: WS_URL, outcome: 'failed: websocket error' }],
      local: { url: LOCAL_URL, outcome: 'succeeded' },
    },
    unhooked: {
      plants: [{ name: 'Bun fetch to oauth2', host: 'oauth2.googleapis.com', outcome: 'failed: ConnectionRefused' }],
    },
  };
}

function readCanaryFile(buildersDir: string): { verdict: CanaryVerdict } {
  const canaryBase = join(buildersDir, 'canary');
  const [stamp] = readdirSync(canaryBase);
  const path = join(canaryBase, stamp ?? '', 'canary.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { verdict: CanaryVerdict };
}

describe('runCanary when the sandbox stop returns still-running', () => {
  test('fails the canary when stop returns still-running, and passes when stop returns exited', async () => {
    const passingRoot = mkdtempSync(join(tmpdir(), 'builders-canary-stop-'));
    const passingBuilders = join(passingRoot, 'builders');
    process.env.PYRIC_BUILDERS_DIR = passingBuilders;
    process.env.PYRIC_HEAVY_RUN_DIR = join(passingRoot, 'slots');
    delete process.env.PYRIC_HEAVY_RUN_SLOT;
    const packagesDir = join(passingRoot, 'packages');

    const ok = await runCanary(
      { build: false, packages: packagesDir },
      {
        preflight: () => [],
        unitTests: async () => {},
        startNamespace: async () => stubNamespace('exited'),
        runPlants: async (_namespace, dirs) => writePassingPlants(dirs),
        expectedPlants: EXPECTED,
      },
    );
    expect(ok).toBe(true);
    expect(readCanaryFile(passingBuilders).verdict.ok).toBe(true);

    const hungRoot = mkdtempSync(join(tmpdir(), 'builders-canary-hung-'));
    const hungBuilders = join(hungRoot, 'builders');
    process.env.PYRIC_BUILDERS_DIR = hungBuilders;
    process.env.PYRIC_HEAVY_RUN_DIR = join(hungRoot, 'slots');
    delete process.env.PYRIC_HEAVY_RUN_SLOT;

    const failed = await runCanary(
      { build: false, packages: join(hungRoot, 'packages') },
      {
        preflight: () => [],
        unitTests: async () => {},
        startNamespace: async () => stubNamespace('still-running'),
        runPlants: async (_namespace, dirs) => writePassingPlants(dirs),
        expectedPlants: EXPECTED,
      },
    );
    expect(failed).toBe(false);
    const saved = readCanaryFile(hungBuilders);
    expect(saved.verdict.ok).toBe(false);
    expect(saved.verdict.checks.filter((check) => !check.ok)).toEqual([
      { name: 'sandbox: stopped cleanly', ok: false, detail: 'still running after SIGKILL' },
    ]);
  });

  test('does not follow a planted canary.json symlink when stop returns still-running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-canary-link-'));
    process.env.PYRIC_BUILDERS_DIR = join(root, 'builders');
    process.env.PYRIC_HEAVY_RUN_DIR = join(root, 'slots');
    delete process.env.PYRIC_HEAVY_RUN_SLOT;
    const decoy = join(root, 'host-decoy');
    writeFileSync(decoy, 'untouched\n');

    const ok = await runCanary(
      { build: false, packages: join(root, 'packages') },
      {
        preflight: () => [],
        unitTests: async () => {},
        startNamespace: async () => stubNamespace('still-running'),
        runPlants: async (_namespace, dirs) => {
          const output = writePassingPlants(dirs);
          symlinkSync(decoy, join(dirs.root, 'canary.json'));
          return output;
        },
        expectedPlants: EXPECTED,
      },
    );
    expect(ok).toBe(false);
    expect(readFileSync(decoy, 'utf8')).toBe('untouched\n');
  });

  test('does not read through a planted network.jsonl symlink when stop returns still-running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-canary-netlink-'));
    const buildersDir = join(root, 'builders');
    process.env.PYRIC_BUILDERS_DIR = buildersDir;
    process.env.PYRIC_HEAVY_RUN_DIR = join(root, 'slots');
    delete process.env.PYRIC_HEAVY_RUN_SLOT;
    const hostEvent = JSON.stringify({
      time: TIME,
      layer: 'node',
      pid: 1,
      thread: 0,
      process: 'host-secret',
      kind: 'connect',
      via: 'socket',
      host: 'firestore.googleapis.com',
      google: true,
      catalogGap: false,
      metadata: false,
      action: 'refused',
    });
    const hostNetwork = join(root, 'host-network.jsonl');
    writeFileSync(hostNetwork, `${hostEvent}\n`);

    const ok = await runCanary(
      { build: false, packages: join(root, 'packages') },
      {
        preflight: () => [],
        unitTests: async () => {},
        startNamespace: async () => stubNamespace('still-running'),
        runPlants: async (_namespace, dirs) => {
          const output = writePassingPlants(dirs);
          unlinkSync(dirs.networkLog);
          symlinkSync(hostNetwork, dirs.networkLog);
          return output;
        },
        expectedPlants: EXPECTED,
      },
    );
    expect(ok).toBe(false);
    expect(readCanaryFile(buildersDir).verdict.googleEvents).toBe(0);
  });

  test('stops the sandbox in finally even when runPlants throws and stop returns still-running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'builders-canary-throw-'));
    process.env.PYRIC_BUILDERS_DIR = join(root, 'builders');
    process.env.PYRIC_HEAVY_RUN_DIR = join(root, 'slots');
    delete process.env.PYRIC_HEAVY_RUN_SLOT;
    let stopCalls = 0;

    const call = runCanary(
      { build: false, packages: join(root, 'packages') },
      {
        preflight: () => [],
        unitTests: async () => {},
        startNamespace: async () => ({
          pid: 0,
          enter: (command, args) => ({ command, args: [...args] }),
          stop: async () => {
            stopCalls += 1;
            return 'still-running';
          },
        }),
        runPlants: async () => {
          throw new Error('plant phase exited 1');
        },
        expectedPlants: EXPECTED,
      },
    );
    await expect(call).rejects.toThrow('plant phase exited 1');
    expect(stopCalls).toBe(1);
  });
});
