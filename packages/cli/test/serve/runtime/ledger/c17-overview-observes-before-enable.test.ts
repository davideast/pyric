import { describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createSdkActivityJournal, sdkActivity } from 'pyric/sandbox/internal';
import { installPyricRuntimeChip } from '../../../../src/serve/runtime/chip-install.js';
import { createPyricRuntimeStatus } from '../../../../src/serve/runtime/status.js';
import type { PyricRuntimeChipOptions } from '../../../../src/serve/runtime/chip.js';
import { createListenerMode } from '../../../../src/serve/runtime/listener-mode.js';

function pageFixture(react = true) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const document = dom.window.document;
  const activity = createSdkActivityJournal();
  let commit: (() => void) | undefined;
  let deliver: ((id: string) => void) | undefined;
  let changed: Element[] = [];
  const stopped = { commits: 0, deliveries: 0, changes: 0, events: 0 };
  const before = performance.now();
  const mode = createListenerMode({
    document, activity, paintStorage: null, themeStorage: null,
    subscribeEvents: () => () => { stopped.events++; },
    commits: {
      available: () => react, reason: () => react ? null : 'no React',
      subscribe(listener) {
        commit = listener;
        return () => { commit = undefined; stopped.commits++; };
      },
      dispose() {},
    },
    flow: {
      subscribeDeliveries(listener) {
        deliver = listener;
        return () => { deliver = undefined; stopped.deliveries++; };
      },
      changedNodes: () => ({
        drain() { const nodes = changed; changed = []; return nodes; },
        discard() { changed = []; },
        stop() { stopped.changes++; },
      }),
    },
  });
  const creationMs = performance.now() - before;
  return {
    document, mode, stopped, creationMs,
    nodes(count = 1) {
      return Array.from({ length: count }, (_, i) => {
        const node = document.createElement('div');
        node.textContent = `Value ${i}`;
        Reflect.set(node, '__reactFiber$fixture', { tag: 5, type: 'div', stateNode: node, return: null, child: null });
        node.getBoundingClientRect = () => new dom.window.DOMRect(12, 34 + i, 80, 20);
        document.body.append(node);
        return node;
      });
    },
    begin(kind: 'operation' | 'subscription') {
      return activity.begin({ app: {}, kind, method: kind === 'operation' ? 'getDocs' : 'onSnapshot',
        source: { service: 'firestore', target: kind, key: kind },
        owners: [{ kind: 'frame', file: '/data.ts', line: 5, function: 'loadData' }],
      });
    },
    queueDelivery(id: string) { deliver?.(id); },
    commitNodes(nodes: Element[]) { changed = nodes; commit?.(); },
    commit(id: string, nodes: Element[]) { deliver?.(id); changed = nodes; commit?.(); },
    boxes() { return [...document.querySelectorAll<HTMLElement>('[data-pyric-listener-box]')]; },
    close() { mode.dispose(); activity.dispose(); dom.window.close(); },
  };
}

describe('Overview observes before enabling paint', () => {
  for (const kind of ['operation', 'subscription'] as const) {
    it(`draws the earlier ${kind} render on first enable and after toggling, without another commit`, () => {
      const page = pageFixture();
      try {
        const record = page.begin(kind);
        record.delivered();
        if (kind === 'operation') record.complete();
        page.commit(record.id, page.nodes());
        expect(page.document.querySelector('[data-pyric-listener-overlay]')).toBeNull();
        expect(page.mode.outlines()[0].selectors).toEqual([]);
        page.mode.setEnabled(true);
        for (let toggle = 0; toggle < 2; toggle++) {
          expect(page.boxes()).toHaveLength(1);
          expect(page.boxes()[0].dataset.listenerId).toBe(record.id);
          expect(page.boxes()[0].style.left).toBe('12px');
          expect(page.boxes()[0].style.top).toBe('34px');
          expect(page.boxes()[0].style.width).toBe('80px');
          expect(page.boxes()[0].style.height).toBe('20px');
          page.mode.setEnabled(false);
          expect(page.boxes()).toHaveLength(0);
          page.mode.setEnabled(true);
        }
      } finally { page.close(); }
    });
  }

  it('releases commit, delivery, DOM and event subscriptions even when painting was never enabled', () => {
    const page = pageFixture();
    page.close();
    expect(page.stopped).toEqual({ commits: 1, deliveries: 1, changes: 1, events: 1 });
  });

  it('keeps the existing unavailable Overview explanation without React commits', () => {
    const page = pageFixture(false);
    try {
      const record = page.begin('subscription');
      record.delivered();
      page.mode.setEnabled(true);
      expect(page.boxes()).toHaveLength(0);
      expect(page.mode.overviewUnavailableReason()).toBe('Overview has no identified page regions to highlight.');
    } finally { page.close(); }
  });

  it("preserves Flow's pre-enable delivery exclusion", () => {
    const page = pageFixture();
    try {
      const record = page.begin('subscription');
      record.delivered();
      page.queueDelivery(record.id);
      page.mode.setMode('flow');
      page.mode.setEnabled(true);
      page.commitNodes(page.nodes());
      expect(page.document.querySelectorAll('[data-pyric-flow]')).toHaveLength(0);
    } finally { page.close(); }
  });

  it('does no render attribution during 200 commits without a delivery', () => {
    const page = pageFixture();
    try {
      const nodes = page.nodes(50);
      // A fiber read would mean the commit entered attribution without data.
      for (const node of nodes) Object.defineProperty(node, '__reactFiber$fixture', {
        get() { throw new Error('Unrelated render entered the fiber walk'); },
      });
      const before = performance.now();
      for (let i = 0; i < 200; i++) page.commitNodes(nodes);
      console.log(`Overview idle cost: 200 commits x 50 nodes=${(performance.now() - before).toFixed(3)}ms`);
      expect(page.mode.history?.counts().commits).toBe(0);
      expect(page.document.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    } finally { page.close(); }
  });

  it('keeps painting off during 200 commits with 50 changed nodes each', () => {
    const page = pageFixture();
    try {
      const nodes = page.nodes(50);
      const record = page.begin('subscription');
      const before = performance.now();
      for (let i = 0; i < 200; i++) { record.delivered(); page.commit(record.id, nodes); }
      const commitsMs = performance.now() - before;
      console.log(`Overview cost: createListenerMode=${page.creationMs.toFixed(3)}ms; 200 commits x 50 nodes=${commitsMs.toFixed(3)}ms`);
      expect(page.document.querySelector('[data-pyric-listener-overlay]')).toBeNull();
      expect(page.document.querySelectorAll('[data-pyric-flow]')).toHaveLength(0);
    } finally { page.close(); }
  });
});


describe('Overview observes before the chip mounts', () => {
  for (const kind of ['operation', 'subscription'] as const) {
    it(`adopts an initial ${kind} delivery and commit made before createListenerMode`, () => {
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
      const document = dom.window.document;
      const commits = new Set<() => void>();
      let chipOptions: PyricRuntimeChipOptions | undefined;
      const installed = installPyricRuntimeChip({
        document, runtime: createPyricRuntimeStatus({ studioUrl: '/__pyric/ui/studio', worker: { url: '/__pyric/sdk/worker.js', name: 'startup', servedEpoch: null } }),
        listenerEvents: () => () => {},
        commits: {
          available: () => true, reason: () => null,
          subscribe(listener) { commits.add(listener); return () => { commits.delete(listener); }; },
          dispose() {},
        },
        // Capture the public mount seam without constructing its listener mode.
        mount(options) { chipOptions = options; return { element: document.createElement('div'), dispose() {} }; },
      });
      const record = sdkActivity.begin({ app: {}, kind,
        method: kind === 'operation' ? 'getDocs' : 'onSnapshot',
        source: { service: 'firestore', target: 'startup', key: `startup-${kind}` },
        owners: [{ kind: 'frame', file: '/data.ts', line: 5, function: 'loadData' }],
      });
      let mode: ReturnType<NonNullable<PyricRuntimeChipOptions['listeners']>> | undefined;
      try {
        record.delivered();
        if (kind === 'operation') record.complete();
        const node = document.createElement('div');
        node.textContent = 'Initial data';
        Reflect.set(node, '__reactFiber$fixture', { tag: 5, type: 'div', stateNode: node, return: null, child: null });
        node.getBoundingClientRect = () => new dom.window.DOMRect(12, 34, 80, 20);
        document.body.append(node);
        for (const commit of commits) commit();
        expect(document.querySelector('[data-pyric-listener-overlay]')).toBeNull();

        mode = chipOptions!.listeners!(() => {});
        mode.setEnabled(true);
        const box = document.querySelector<HTMLElement>(`[data-pyric-listener-box][data-listener-id="${record.id}"]`);
        expect(box).not.toBeNull();
        expect(box?.style.left).toBe('12px');
        expect(box?.style.width).toBe('80px');
        expect(mode.history?.counts().commits).toBe(1);
      } finally {
        mode?.dispose(); installed?.dispose(); record.complete(); dom.window.close();
      }
    });
  }
});
