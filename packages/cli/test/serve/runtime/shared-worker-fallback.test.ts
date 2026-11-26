import { describe, expect, it } from 'bun:test';
import {
  classifySharedWorkerFallback,
  formatMissingWorkerTransportError,
  formatSharedWorkerFallbackSignpost,
  warnSharedWorkerFallbackOnce,
} from '../../../src/serve/runtime/shared-worker-fallback.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';

const TEST_MANIFEST: PyricRuntimeManifest = {
  chip: 'auto',
  studioUrl: '/__pyric/studio/',
  worker: {
    url: '/__pyric/sdk/worker.js',
    servedEpoch: 'epoch-1',
  },
};

describe('shared-worker-fallback', () => {
  it('classifies unsupported, blocked, forced, and connected states', () => {
    expect(
      classifySharedWorkerFallback({
        hasSharedWorker: false,
        forceInPage: false,
        workerConnected: false,
        hasBroadcastChannel: true,
      }),
    ).toEqual({
      reason: 'shared-worker-unsupported',
      tabSyncAvailable: true,
    });

    expect(
      classifySharedWorkerFallback({
        hasSharedWorker: true,
        forceInPage: false,
        workerConnected: false,
        hasBroadcastChannel: false,
      }),
    ).toEqual({
      reason: 'shared-worker-blocked',
      tabSyncAvailable: false,
    });

    expect(
      classifySharedWorkerFallback({
        hasSharedWorker: true,
        forceInPage: true,
        workerConnected: false,
        hasBroadcastChannel: true,
      }),
    ).toEqual({
      reason: 'forced-in-page',
      tabSyncAvailable: true,
    });

    expect(
      classifySharedWorkerFallback({
        hasSharedWorker: true,
        forceInPage: false,
        workerConnected: true,
        hasBroadcastChannel: true,
      }),
    ).toBeNull();
  });

  it('formats an older-Safari signpost naming BroadcastChannel degradation and --hosted', () => {
    const withTabSync = formatSharedWorkerFallbackSignpost({
      reason: 'shared-worker-unsupported',
      tabSyncAvailable: true,
    });
    expect(withTabSync).not.toBeNull();
    expect(withTabSync).toContain('SharedWorker is unavailable in this browser');
    expect(withTabSync).toContain('Safari < 16.4');
    expect(withTabSync).toContain('BroadcastChannel cross-tab sync');
    expect(withTabSync).toContain('worker-backed Storage sharing');
    expect(withTabSync).toContain('live Studio worker plane');
    expect(withTabSync).toContain('pyric sandbox --hosted');
    expect(withTabSync).toContain('pyric({ hosted: true })');

    const withoutTabSync = formatSharedWorkerFallbackSignpost({
      reason: 'shared-worker-unsupported',
      tabSyncAvailable: false,
    });
    expect(withoutTabSync).toContain('BroadcastChannel is also unavailable, so tabs do not sync');
    expect(withoutTabSync).toContain('pyric sandbox --hosted');
  });

  it('formats a policy-blocked SharedWorker signpost and stays silent when forced in-page', () => {
    const blocked = formatSharedWorkerFallbackSignpost({
      reason: 'shared-worker-blocked',
      tabSyncAvailable: true,
    });
    expect(blocked).toContain('SharedWorker failed to start in this browser context.');
    expect(blocked).toContain('pyric sandbox --hosted');

    expect(
      formatSharedWorkerFallbackSignpost({
        reason: 'forced-in-page',
        tabSyncAvailable: true,
      }),
    ).toBeNull();
  });

  it('warns at most once per browser realm and never warns for forced-in-page', () => {
    const warnings: string[] = [];
    const realmA = {};
    const realmB = {};

    expect(
      warnSharedWorkerFallbackOnce(
        { reason: 'forced-in-page', tabSyncAvailable: true },
        { realm: realmA, warn: (msg) => warnings.push(msg) },
      ),
    ).toBe(false);
    expect(warnings).toHaveLength(0);

    expect(
      warnSharedWorkerFallbackOnce(
        { reason: 'shared-worker-unsupported', tabSyncAvailable: true },
        { realm: realmA, warn: (msg) => warnings.push(msg) },
      ),
    ).toBe(true);
    expect(
      warnSharedWorkerFallbackOnce(
        { reason: 'shared-worker-unsupported', tabSyncAvailable: true },
        { realm: realmA, warn: (msg) => warnings.push(msg) },
      ),
    ).toBe(false);
    expect(warnings).toHaveLength(1);

    expect(
      warnSharedWorkerFallbackOnce(
        { reason: 'shared-worker-blocked', tabSyncAvailable: false },
        { realm: realmB, warn: (msg) => warnings.push(msg) },
      ),
    ).toBe(true);
    expect(warnings).toHaveLength(2);
  });

  it('evaluates feature detection honestly when SharedWorker and BroadcastChannel globals are deleted', () => {
    const g = globalThis as Record<string, unknown>;
    const hadSharedWorker = 'SharedWorker' in g;
    const prevSharedWorker = g.SharedWorker;
    const hadBroadcastChannel = 'BroadcastChannel' in g;
    const prevBroadcastChannel = g.BroadcastChannel;

    try {
      Reflect.deleteProperty(g, 'SharedWorker');
      Reflect.deleteProperty(g, 'BroadcastChannel');

      const fallback = classifySharedWorkerFallback({
        hasSharedWorker: typeof SharedWorker !== 'undefined',
        forceInPage: false,
        workerConnected: false,
        hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
      });
      expect(fallback).toEqual({
        reason: 'shared-worker-unsupported',
        tabSyncAvailable: false,
      });

      const errText = formatMissingWorkerTransportError({
        hasSharedWorker: typeof SharedWorker !== 'undefined',
      });
      expect(errText).toContain('No Pyric worker transport is initialized in this browser context');
      expect(errText).toContain('Safari < 16.4');
      expect(errText).toContain('pyric sandbox --hosted');
    } finally {
      if (hadSharedWorker) {
        g.SharedWorker = prevSharedWorker;
      } else {
        Reflect.deleteProperty(g, 'SharedWorker');
      }
      if (hadBroadcastChannel) {
        g.BroadcastChannel = prevBroadcastChannel;
      } else {
        Reflect.deleteProperty(g, 'BroadcastChannel');
      }
    }
  });

  it('tracks inPageFallback on PyricRuntimeStatus and clears it on worker or hosted attach', () => {
    const status = createPyricRuntimeStatus(TEST_MANIFEST);
    expect(status.getSnapshot().inPageFallback).toBeNull();

    status.setWorker({
      mode: 'in-page',
      inPageFallback: {
        reason: 'shared-worker-unsupported',
        tabSyncAvailable: true,
      },
    });
    expect(status.getSnapshot().mode).toBe('in-page');
    expect(status.getSnapshot().inPageFallback).toEqual({
      reason: 'shared-worker-unsupported',
      tabSyncAvailable: true,
    });

    status.setWorker({ mode: 'hosted', runningEpoch: null });
    expect(status.getSnapshot().mode).toBe('hosted');
    expect(status.getSnapshot().inPageFallback).toBeNull();
  });
});
