import 'fake-indexeddb/auto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { captureCheckpoint, type Checkpoint } from 'pyric/sandbox/checkpoints';
import { getFirestore } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { buildReproFile } from '../../../src/serve/repro/capture.js';
import { listDenials } from '../../../src/serve/repro/denials.js';
import { parseRepro, type ReproBase } from '../../../src/serve/repro/format.js';
import {
  createReproRecorder,
  DEFAULT_REPRO_WINDOW_BYTES,
  type RecordedEntry,
} from '../../../src/serve/repro/recorder.js';
import { replayRepro } from '../../../src/serve/repro/replay.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

async function createEmptyCheckpoint(): Promise<Checkpoint> {
  const sandbox = initializeSandbox();
  try {
    return await captureCheckpoint(sandbox);
  } finally {
    sandbox.dispose();
  }
}

function emptyBase(checkpoint: Checkpoint, at = 0): Omit<ReproBase, 'subscriptions'> {
  return {
    at,
    checkpoint,
    databaseInstances: {},
    rules: { firestore: null, database: {}, storage: null },
    defaultInstance: '(default)',
    permissive: false,
    appOptions: null,
    sessions: {},
  };
}

function encodedBytes(entries: RecordedEntry[]): number {
  let total = 0;
  const encoder = new TextEncoder();
  for (const entry of entries) {
    total += encoder.encode(JSON.stringify(entry)).byteLength;
  }
  return total;
}

describe('repro recorder byte ceiling (#1957)', () => {
  test('exposes a 2 MiB default window byte limit', () => {
    expect(DEFAULT_REPRO_WINDOW_BYTES).toBe(2 * 1024 * 1024);
  });

  test('rolls windows by byteLimit well before entry count limit and replays cleanly', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const openRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read, write: if true; }
  }
}`;
    setRules(sandbox, openRules);

    try {
      const ctx: HostCtx = {
        db,
        sandbox,
        instanceId: 'repro-byte-rollover',
        subs: new Map(),
        flushPersistence: async () => {},
      };
      let captures = 0;
      const byteLimit = 4_096;
      const recorder = createReproRecorder({
        limit: 1_000,
        byteLimit,
        capture: async () => {
          captures += 1;
          const checkpoint = await captureCheckpoint(sandbox);
          return {
            at: Date.now(),
            checkpoint,
            databaseInstances: {},
            rules: { firestore: openRules, database: {}, storage: null },
            defaultInstance: '(default)',
            permissive: false,
            appOptions: null,
            sessions: {},
          };
        },
      });

      const body = 'x'.repeat(1_200);
      for (let index = 0; index < 12; index += 1) {
        const id = `op-${index}`;
        const inbound: InboundMessage = {
          t: 'op',
          id,
          method: 'setDoc',
          path: `items/doc-${index % 3}`,
          data: { index, body },
        };
        await recorder.inbound('tab-1', inbound);
        await new Promise<void>((resolveOp) => {
          const port: PortLike = {
            postMessage(msg: OutboundMessage) {
              recorder.outbound('tab-1', msg);
              if (msg.t === 'res' && msg.id === id) resolveOp();
            },
          };
          void handleMessage(ctx, port, inbound);
        });
      }

      expect(captures).toBeGreaterThan(1);
      const log = await recorder.log();
      expect(log.truncated).toBe(true);
      expect(encodedBytes(log.entries)).toBeLessThanOrEqual(byteLimit * 2);

      const built = await buildReproFile(log, () => undefined);
      const parsed = parseRepro(JSON.parse(JSON.stringify(built)));
      const report = await replayRepro(parsed, { planes: ['worker'] });
      expect(report.ok).toBe(true);
      expect(report.planes.worker?.divergences).toEqual([]);
    } finally {
      sandbox.dispose();
    }
  });

  test('evicts oversized snapshot bursts, backs off capture thrashing, keeps denials and open subscriptions, and recovers', async () => {
    const checkpoint = await createEmptyCheckpoint();
    let clock = 1_000;
    let captures = 0;
    const droppedUploadIds: string[] = [];
    const byteLimit = 2_048;

    const recorder = createReproRecorder({
      limit: 1_000,
      byteLimit,
      now: () => {
        clock += 1;
        return clock;
      },
      capture: async () => {
        captures += 1;
        return emptyBase(checkpoint, clock);
      },
      onDrop(dropped) {
        for (const item of dropped) {
          if (item.kind === 'upload-slice') droppedUploadIds.push(item.uploadId);
        }
      },
    });

    await recorder.inbound('tab-1', {
      t: 'sub',
      subId: 'sub-items',
      target: { __ref: 'collection', path: 'items' },
    });
    recorder.note({
      kind: 'upload-slice',
      at: clock,
      uploadId: 'up-evicted',
      partIndex: 0,
      offset: 0,
      length: 64,
    });

    // Denied operation before oversized snapshot traffic.
    await recorder.inbound('tab-1', {
      t: 'op',
      id: 'deny-before',
      method: 'getDoc',
      path: 'items/secret',
    });
    recorder.outbound('tab-1', {
      t: 'res',
      id: 'deny-before',
      ok: false,
      error: {
        code: 'permission-denied',
        message: 'Permission denied',
        denialContext: {
          auth: null,
          reasons: ['allow read: false'],
          request: { method: 'get', path: 'items/secret' },
          rule: {
            line: 3,
            col: 7,
            citation: 'firestore.rules:3:7',
            expression: 'false',
          },
        },
      },
    });

    const hugeSnapPayload = 's'.repeat(byteLimit * 3);
    const totalBurstWrites = 40;
    for (let index = 0; index < totalBurstWrites; index += 1) {
      const id = `burst-${index}`;
      await recorder.inbound('tab-1', {
        t: 'op',
        id,
        method: 'setDoc',
        path: 'items/doc-0',
        data: { index },
      });
      recorder.outbound('tab-1', { t: 'res', id, ok: true, value: null });
      recorder.outbound('tab-1', {
        t: 'snap',
        subId: 'sub-items',
        value: { docs: [hugeSnapPayload] },
      });
    }

    // Exponential eviction backoff avoids capturing a starting state on every write.
    expect(captures).toBeLessThan(12);
    expect(droppedUploadIds).toContain('up-evicted');

    const log = await recorder.log();
    expect(log.truncated).toBe(true);
    expect(log.base.subscriptions['tab-1']?.length).toBe(1);
    expect(encodedBytes(log.entries)).toBeLessThanOrEqual(byteLimit * 2);

    const built = await buildReproFile(log, () => undefined);
    const groups = listDenials(built, {});
    expect(groups).toHaveLength(1);
    expect(groups[0]?.paths).toEqual(['items/secret']);
  });

  test('matches multi-byte UTF-8 byte accounting with and without Buffer', async () => {
    const checkpoint = await createEmptyCheckpoint();
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    const accentPayload = '\u00e9'.repeat(300);

    async function runSequence(): Promise<number> {
      const recorder = createReproRecorder({
        byteLimit: 1_200,
        now: () => 42,
        capture: async () => emptyBase(checkpoint, 40),
      });
      for (let index = 0; index < 6; index += 1) {
        const id = `u-${index}`;
        await recorder.inbound('tab-1', {
          t: 'op',
          id,
          method: 'rtdb.set',
          instance: undefined,
          path: `/items/k-${index}`,
          value: accentPayload,
        });
        recorder.outbound('tab-1', { t: 'res', id, ok: true, value: null });
      }
      const log = await recorder.log();
      return log.entries.length;
    }

    const withBufferCount = await runSequence();
    try {
      Reflect.deleteProperty(globalThis, 'Buffer');
      const withoutBufferCount = await runSequence();
      expect(withoutBufferCount).toBe(withBufferCount);
    } finally {
      if (bufferDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'Buffer', bufferDescriptor);
      }
    }
  });

  test('keeps Node host collected heap bounded under large writes with an attached collection listener', () => {
    const runtimeDist = join(repoRoot, 'packages/cli/dist/serve/hosted/runtime.js');
    const persistenceDist = join(repoRoot, 'packages/cli/dist/serve/hosted/persistence.js');
    if (!existsSync(runtimeDist) || !existsSync(persistenceDist)) {
      return;
    }
    const script = [
      "import { mkdtempSync, realpathSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      `import { createHostedRuntime } from ${JSON.stringify(runtimeDist)};`,
      `import { createHostedPersistence } from ${JSON.stringify(persistenceDist)};`,
      'function heapMiB() { global.gc(); global.gc(); return process.memoryUsage().heapUsed / (1024 * 1024); }',
      "const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-1957-test-')));",
      'const persistence = await createHostedPersistence(dir);',
      'let waitId = null; let pendingResolve = null;',
      'const runtime = await createHostedRuntime({',
      '  rules: "rules_version = \'2\'; service cloud.firestore { match /databases/{db}/documents { match /{document=**} { allow read, write: if true; } } }",',
      '  rulesHash: null, storageRules: null, storageRulesHash: null,',
      "  databaseInstances: { defaultInstance: '(default)', rules: {} },",
      '  permissive: true, bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: dir, messaging: false,',
      "}, 'http://127.0.0.1:1', (msg) => {",
      "  if (msg.type === 'worker-message-result' && msg.message.t === 'res' && msg.message.id === waitId && pendingResolve) {",
      '    const r = pendingResolve; pendingResolve = null; r(msg.message);',
      '  }',
      '}, dir, { persistence });',
      "runtime.receive({ type: 'worker-message', clientSessionId: 'c1', message: { t: 'sub', subId: 's1', target: { __ref: 'collection', path: 'items' } } });",
      'await new Promise((r) => setTimeout(r, 15));',
      'const start = heapMiB();',
      "const body = 'x'.repeat(500 * 1024);",
      'for (let i = 0; i < 60; i += 1) {',
      '  const id = `w-${i}`;',
      '  await new Promise((resolve) => {',
      '    waitId = id; pendingResolve = resolve;',
      "    runtime.receive({ type: 'worker-message', clientSessionId: 'c1', message: { t: 'op', id, method: 'setDoc', path: `items/doc-${i % 8}`, data: { i, body: body + i } } });",
      '  });',
      '}',
      'const end = heapMiB();',
      'await runtime.close(); persistence.close(); rmSync(dir, { recursive: true, force: true });',
      'console.log(JSON.stringify({ start, end, delta: end - start }));',
    ].join('\n');

    const result = spawnSync('node', ['--expose-gc', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1] ?? '{}';
    const metrics = JSON.parse(lastLine) as { start: number; end: number; delta: number };
    // Assert bounded post-baseline heap growth (60 x 500 KB writes + 8-doc
    // collection listener previously retained ~250 MiB of snapshots). Avoid a
    // tight absolute heapUsed cap that varies across Node 22/24 cold imports.
    expect(metrics.delta).toBeLessThan(35);
    expect(metrics.end).toBeLessThan(150);
  }, 30_000);
});
