/**
 * Issue #1960: served `runTransaction` retries must back off using the same
 * exponential backoff curve as `@firebase/firestore` 4.17.2 `TransactionRunner`
 * (`ExponentialBackoff`: 1000 ms initial, factor 1.5, 60 s cap, +/- 50% jitter)
 * so contending clients complete reliably instead of exhausting 5 attempts.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FirebaseError } from 'pyric/app';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import * as workerClient from '../../../../src/serve/worker/client.js';
import { TransactionRetryBackoff } from '../../../../src/serve/worker/client/firestore-transaction-backoff.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;

describe('TransactionRetryBackoff (#1960)', () => {
  it('follows @firebase/firestore ExponentialBackoff curve (0 ms, 1000 ms, factor 1.5, cap 60000 ms)', async () => {
    let clockMs = 10_000;
    const sleeps: number[] = [];
    const backoff = new TransactionRetryBackoff({
      now: () => clockMs,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        clockMs += ms;
      },
    });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      delays.push(await backoff.waitForNextAttempt());
    }
    expect(delays).toEqual([0, 1000, 1500, 2250, 3375]);
    expect(sleeps).toEqual([1000, 1500, 2250, 3375]);

    let lastDelay = 0;
    for (let i = 0; i < 20; i += 1) {
      lastDelay = await backoff.waitForNextAttempt();
    }
    expect(lastDelay).toBe(60_000);
  });

  it('applies +/- 50% jitter and subtracts elapsed time since the previous attempt started', async () => {
    let clockMs = 5_000;
    let nextRandom = 0.0;
    const backoff = new TransactionRetryBackoff({
      now: () => clockMs,
      random: () => nextRandom,
      sleep: async (ms) => {
        clockMs += ms;
      },
    });

    expect(await backoff.waitForNextAttempt()).toBe(0);

    // Simulate 150 ms spent executing attempt 1; min jitter gives 500 ms desired -> 350 ms remaining.
    clockMs += 150;
    nextRandom = 0.0;
    expect(await backoff.waitForNextAttempt()).toBe(350);

    // Simulate clock moving backward; max jitter on 1500 ms base gives 2250 ms.
    clockMs -= 500;
    nextRandom = 1.0;
    expect(await backoff.waitForNextAttempt()).toBe(2250);

    // Simulate elapsed time exceeding the desired delay -> 0 ms remaining.
    clockMs += 10_000;
    nextRandom = 0.5;
    expect(await backoff.waitForNextAttempt()).toBe(0);
  });
});

describe('served runTransaction retry backoff and contention (#1960)', () => {
  it('backs off before retrying on conflict and rejects without extra delay after final attempt', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(OPEN_RULES);
    compat.seed({ documents: { 'docs/d1': { n: 0 } } });
    const db = getFirestore(sandbox);
    const ctx: HostCtx = { sandbox, db, instanceId: 'txn-backoff-timing', subs: new Map() };

    let bump = 0;
    const hostPort: PortLike = {
      postMessage(message: OutboundMessage) {
        queueMicrotask(() => {
          clientPort.onmessage?.(new MessageEvent('message', { data: message }));
        });
      },
    };
    const clientPort: ClientPort = {
      onmessage: null,
      postMessage(message: InboundMessage) {
        queueMicrotask(async () => {
          if (message.t === 'op' && message.method === 'txnCommit') {
            sandbox.admin.setDocument('docs/d1', { n: ++bump });
          }
          await handleMessage(ctx, hostPort, message);
        });
      },
      start() {},
      close() {
        clientPort.onmessage = null;
      },
    };
    const prevSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor() {}
    };

    try {
      const wdb = workerClient.getFirestore('worker://txn-backoff-timing');
      const attemptTimes: number[] = [];
      const err = await workerClient.runTransaction(
        wdb,
        async (tx) => {
          attemptTimes.push(Date.now());
          const ref = workerClient.doc(wdb, 'docs/d1');
          const snap = await tx.get(ref);
          const current = (snap.data()?.n as number) ?? 0;
          tx.set(ref, { n: current + 1 });
        },
        { maxAttempts: 2 },
      ).catch((e) => e);

      expect(attemptTimes).toHaveLength(2);
      const retryGapMs = attemptTimes[1] - attemptTimes[0];
      expect(retryGapMs).toBeGreaterThanOrEqual(450);
      expect(err).toBeInstanceOf(FirebaseError);
      expect((err as FirebaseError).code).toBe('failed-precondition');
    } finally {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevSharedWorker;
      clientPort.close();
      sandbox.dispose();
    }
  });

  it('completes 3 contending clients x 40 transactions on one document without exhausting retries', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(OPEN_RULES);
    compat.seed({ documents: { 'counters/c1': { n: 0 } } });
    const db = getFirestore(sandbox);
    const ctx: HostCtx = { sandbox, db, instanceId: 'txn-backoff-contention', subs: new Map() };

    const prevSharedWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    const ports: ClientPort[] = [];

    function makeClient(index: number) {
      const hostPort: PortLike = {
        postMessage(message: OutboundMessage) {
          setTimeout(() => {
            clientPort.onmessage?.(new MessageEvent('message', { data: message }));
          }, 2);
        },
      };
      const clientPort: ClientPort = {
        onmessage: null,
        postMessage(message: InboundMessage) {
          setTimeout(() => {
            void handleMessage(ctx, hostPort, message);
          }, 2);
        },
        start() {},
        close() {
          clientPort.onmessage = null;
        },
      };
      ports.push(clientPort);
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor() {}
      };
      return workerClient.getFirestore(`worker://txn-backoff-contention-${index}`);
    }

    try {
      const clients = [makeClient(1), makeClient(2), makeClient(3)];
      await Promise.all(
        clients.map(async (wdb) => {
          for (let i = 0; i < 40; i += 1) {
            await workerClient.runTransaction(wdb, async (tx) => {
              const ref = workerClient.doc(wdb, 'counters/c1');
              const snap = await tx.get(ref);
              const current = (snap.data()?.n as number) ?? 0;
              tx.update(ref, { n: current + 1 });
            });
          }
        }),
      );
      expect(sandbox.admin.getDocument('counters/c1')).toEqual({ n: 120 });
    } finally {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevSharedWorker;
      for (const port of ports) {
        port.close();
      }
      sandbox.dispose();
    }
  }, 30_000);
});
