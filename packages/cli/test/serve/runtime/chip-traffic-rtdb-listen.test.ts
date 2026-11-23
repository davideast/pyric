import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import * as database from 'pyric/database';
import { createSdkRateMonitor, sdkActivity } from 'pyric/sandbox/internal';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { IndexConfigClient } from '../../../src/serve/runtime/index-config-client.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

function mountChipWithSandbox(
  rulesConfig: { rules: Record<string, unknown> },
  seed: Record<string, unknown>,
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const sandbox = initializeSandbox();
  const rtdb = database.getDatabase(sandbox);
  database.sandbox.setRules(rtdb, rulesConfig);
  if (Object.keys(seed).length > 0) {
    database.sandbox.setData(rtdb, seed as Record<string, database.sandbox.JsonValue>);
  }

  const runtime = createPyricRuntimeStatus(manifest);
  const monitor = createSdkRateMonitor(sdkActivity);
  const indexConfig: IndexConfigClient = {
    async read(service) {
      if (service === 'rtdb') return { path: 'database.rules.json', config: rulesConfig };
      return null;
    },
    async write() {
      return { path: 'database.rules.json', config: rulesConfig };
    },
  };

  const listeners = new Set<(events: readonly SandboxEvent[], batch: { history: boolean }) => void>();
  const stopSandbox = sandbox.onEvent((event) => {
    runtime.recordSandboxEvents([event]);
    for (const listener of listeners) listener([event], { history: false });
  });

  const chip = mountPyricRuntimeChip({
    rates: monitor,
    runtime,
    document: dom.window.document,
    initiallyOpen: true,
    thresholdConfig: null,
    indexConfig,
    sandboxEvents: (callback) => {
      callback(sandbox.history(), { history: true });
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    identity: { getCurrentUser: () => null, subscribeAuth: () => () => {} },
  });

  cleanups.push(() => {
    stopSandbox();
    chip.dispose();
    monitor.dispose();
    dom.window.close();
  });

  const root = chip.element.shadowRoot;
  if (!root) throw new Error('Expected shadowRoot');
  return { rtdb, runtime, monitor, root };
}

function methodCalls(monitor: ReturnType<typeof createSdkRateMonitor>, method: string): number {
  const rtdbService = monitor.snapshot().services.find((entry) => entry.service === 'rtdb');
  const row = rtdbService?.methods.find((entry) => entry.method === method);
  if (!row) return 0;
  return row.buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
}

describe('RTDB listen rows in Traffic match SDK calls (#1078)', () => {
  it('shows one rtdb.listen row carrying both the rules outcome and missing-index finding for an unindexed onValue query', async () => {
    const { rtdb, monitor, root } = mountChipWithSandbox(
      { rules: { '.read': true, '.write': true, projects: {} } },
      { projects: { small: { budget: 10 }, large: { budget: 40 } } },
    );
    await Promise.resolve();
    await Promise.resolve();

    const unindexed = database.query(database.ref(rtdb, 'projects'), database.orderByChild('budget'));
    const received: unknown[] = [];
    const unsubscribe = database.onValue(unindexed, (snap) => {
      received.push(snap.val());
    });
    unsubscribe();

    expect(received.length).toBe(1);
    expect(methodCalls(monitor, 'onValue')).toBe(1);

    root.querySelector<HTMLButtonElement>('[data-chip-tab="traffic"]')?.click();
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-request-row]')].filter(
      (row) => row.dataset.trafficRowCall === 'rtdb.listen',
    );
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.querySelector('.c2')?.textContent).toBe('/projects');
    expect(row?.querySelector('.index-warning')?.getAttribute('aria-label')).toBe('Index missing from config');
    expect(row?.getAttribute('aria-label')).toContain('rtdb.listen: /projects. ok');

    row?.click();
    const detailText = root.querySelector('[data-traffic-detail]')?.textContent ?? '';
    expect(detailText).toContain('Succeeded');
    expect(root.querySelector('[data-index-details]')?.textContent).toContain('Missing from config');
    expect(root.querySelector('[data-index-details]')?.textContent).toContain('budget');
  });

  it('shows one Allowed rtdb.listen row when the query is indexed or listens to a plain path', async () => {
    const { rtdb, monitor, root } = mountChipWithSandbox(
      { rules: { '.read': true, '.write': true, projects: { '.indexOn': 'budget' } } },
      { projects: { small: { budget: 10 } } },
    );
    await Promise.resolve();
    await Promise.resolve();

    const indexed = database.query(database.ref(rtdb, 'projects'), database.orderByChild('budget'));
    const stopIndexed = database.onValue(indexed, () => {});
    const stopChild = database.onChildAdded(database.ref(rtdb, 'projects'), () => {});
    stopIndexed();
    stopChild();

    expect(methodCalls(monitor, 'onValue')).toBe(1);
    expect(methodCalls(monitor, 'onChildAdded')).toBe(1);

    root.querySelector<HTMLButtonElement>('[data-chip-tab="traffic"]')?.click();
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-request-row]')].filter(
      (row) => row.dataset.trafficRowCall === 'rtdb.listen',
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector('.verdict')?.getAttribute('aria-label')).toBe('Succeeded');
    }
  });

  it('shows one Denied rtdb.listen row and one runtime error when rules deny onValue', () => {
    const { rtdb, runtime, monitor, root } = mountChipWithSandbox(
      { rules: { '.read': false, '.write': false } },
      {},
    );

    const canceled: string[] = [];
    database.onValue(
      database.ref(rtdb, 'secret'),
      () => {},
      (err) => canceled.push(err.message),
    );

    expect(methodCalls(monitor, 'onValue')).toBe(1);
    expect(runtime.getSnapshot().errors).toHaveLength(1);

    root.querySelector<HTMLButtonElement>('[data-chip-tab="traffic"]')?.click();
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-request-row]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.trafficRowCall).toBe('rtdb.listen');
    expect(rows[0]?.querySelector('.verdict')?.getAttribute('aria-label')).toBe('Denied');
  });
});
