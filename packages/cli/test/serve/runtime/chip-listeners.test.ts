import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { mountPyricRuntimeChip } from '../../../src/serve/runtime/chip.js';
import { createPyricRuntimeStatus } from '../../../src/serve/runtime/status.js';
import type { PyricRuntimeManifest } from '../../../src/serve/runtime/manifest.js';
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';
import type { ListenerPaintMode } from '../../../src/serve/runtime/listener-paint-mode.js';
import { LISTENER_PAINT_MODE_KEY } from '../../../src/serve/runtime/listener-paint-mode.js';

const manifest: PyricRuntimeManifest = {
  studioUrl: '/__pyric/ui/studio',
  worker: { url: '/__pyric/sdk/worker.js', name: 'pyric-shared-worker', servedEpoch: 'bbbbbbbbbbbbbbbb' },
};

type Target = { kind: 'doc'; path: string } | { kind: 'query'; collection: string };

function attach(id: string, listenerId: string, target: Target, owners: unknown[]): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at: 1,
    listenerId,
    target,
    auth: null,
    owners,
  } as unknown as SandboxEvent;
}

function delivery(id: string, listenerId: string, target: Target): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at: 2,
    listenerId,
    target,
    auth: null,
  } as unknown as SandboxEvent;
}

/** A duplicate-listener incident over the attaches whose ids the caller names,
 * or every attach the page has seen. */
function duplicateIncidents(
  events: readonly SandboxEvent[],
  only?: readonly string[],
): readonly ActivityIncident[] {
  const attachIds = events
    .filter((event) => (event as { kind: string }).kind === 'listener_attach')
    .map((event) => (event as { id: string }).id)
    .filter((id) => only === undefined || only.includes(id));
  if (attachIds.length === 0) return [];
  return [{
    fingerprint: 'fp1',
    pattern: 'duplicate-listener',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'listen',
    targetFingerprint: 'conversations',
    actor: { kind: 'unknown' },
    authLens: 'app',
    authUid: null,
    count: 2,
    windowMs: 5000,
    evidenceEventIds: attachIds,
  } as unknown as ActivityIncident];
}

function setup(options: {
  attributionEnabled?: boolean;
  studioUrl?: string | null;
  incidents?: (events: readonly SandboxEvent[]) => readonly ActivityIncident[];
  /** Whether the page has a React whose commits the chip can read. */
  react?: boolean;
  /** The painting mode the page remembers from a previous session. */
  rememberedPaintMode?: ListenerPaintMode;
} = {}) {
  const paintStore = new Map<string, string>();
  if (options.rememberedPaintMode !== undefined) {
    paintStore.set(LISTENER_PAINT_MODE_KEY, options.rememberedPaintMode);
  }
  const paintStorage = {
    getItem: (key: string) => paintStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      paintStore.set(key, value);
    },
  };
  const dom = new JSDOM(
    '<!doctype html><body><div id="todos"><span id="row">a</span></div><div id="profile"></div></body>',
    { url: 'http://localhost/' },
  );
  const doc = dom.window.document;
  // A row React rendered inline inside the todos region, so a delivery has
  // something the fiber walk can attribute.
  const rowEl = doc.querySelector('#row')!;
  const regionHost = { tag: 5, type: 'div', stateNode: doc.querySelector('#todos')!, return: null, child: null };
  (rowEl as unknown as Record<string, unknown>)['__reactFiber$k'] = {
    tag: 5, type: 'span', stateNode: rowEl, return: regionHost, child: null,
  };
  let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
  let delivered: ((listenerId: string) => void) | null = null;
  let commit: (() => void) | null = null;
  let changedNodes: unknown[] = [];
  const chip = mountPyricRuntimeChip({
    runtime: createPyricRuntimeStatus(manifest),
    document: doc,
    initiallyOpen: true,
    ...('studioUrl' in options ? { studioUrl: options.studioUrl } : {}),
    identity: { subscribeAuth: () => () => {} },
    getLens: () => undefined,
    setLens: () => {},
    subscribeLens: () => () => {},
    listeners: (onChange) => createListenerMode({
      document: doc,
      onChange,
      attributionEnabled: () => options.attributionEnabled ?? true,
      incidents: options.incidents ?? (() => []),
      commits: {
        available: () => options.react ?? false,
        reason: () => ((options.react ?? false) ? null : 'no React'),
        subscribe: (listener) => {
          commit = listener;
          return () => {
            commit = null;
          };
        },
        dispose: () => {},
      },
      paintStorage,
      flow: {
        subscribeDeliveries: (listener) => {
          delivered = listener;
          return () => {
            delivered = null;
          };
        },
        changedNodes: () => ({
          drain: () => {
            const drained = changedNodes;
            changedNodes = [];
            return drained;
          },
          stop: () => {},
        }),
      },
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {
          deliver = null;
        };
      },
    }),
  });
  const root = chip.element.shadowRoot!;
  root.querySelector<HTMLButtonElement>('[data-chip-tab="listeners"]')!.click();
  return {
    doc,
    chip,
    paintStore,
    root,
    push: (events: readonly SandboxEvent[]) => deliver?.(events),
    /** A delivery the worker client reported, and the render that followed. */
    flowDelivery: (listenerId: string) => {
      delivered?.(listenerId);
      changedNodes = [rowEl];
      commit?.();
    },
  };
}

function bar(root: ShadowRoot, which: ListenerPaintMode): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-listener-mode="${which}"]`)!;
}

const owner = { kind: 'component', name: 'TodoList', element: '#todos' };

describe('the Listeners view', () => {
  it('gives every listener one row: the owner over its target in the listener hue, and its deliveries in the slot', () => {
    const page = setup();
    page.push([attach('a1', 'L1', { kind: 'query', collection: 'todos' }, [owner]), delivery('d1', 'L1', { kind: 'query', collection: 'todos' })]);
    const row = page.root.querySelector('[data-listener-row="L1"]')!;
    expect(row.querySelector('.c1')!.textContent).toBe('TodoList');
    expect(row.querySelector('.s1')!.textContent).toBe('todos (query)');
    expect(row.querySelector<HTMLElement>('.s1 .mono')!.style.color).not.toBe('');
    expect(row.querySelector('.slot')!.textContent).toBe('1');
    expect(row.querySelector('.slot .btn')).toBeNull();
    expect(row.tagName).toBe('BUTTON');
  });

  it('puts a duplicate subscription first as its own row in the error colour', () => {
    const page = setup({ incidents: duplicateIncidents });
    page.push([
      attach('a1', 'L1', { kind: 'query', collection: 'todos' }, [owner]),
      attach('a2', 'L2', { kind: 'query', collection: 'todos' }, [owner]),
    ]);
    const first = page.root.querySelector('[data-listener-rows] .row')!;
    expect(first.getAttribute('data-listener-incident')).not.toBeNull();
    expect(first.classList.contains('problem')).toBe(true);
    expect(first.querySelector('.c1')!.textContent).toBe('Duplicate subscription');
    expect(first.querySelector('.s1')!.textContent).toBe('todos (query)');
    expect(first.querySelector('.slot')!.textContent).toBe('2');
    expect(page.root.querySelector('[data-chip-tab="listeners"]')!.classList.contains('problem')).toBe(true);
  });

  it('offers Overview, Flow, and Theme in the bar, with nothing pressed while the outlines are off', () => {
    const page = setup({ rememberedPaintMode: 'flow', react: true });
    expect([...page.root.querySelectorAll('[data-action-bar] .btn')].map((b) => b.textContent)).toEqual(['Overview', 'Flow', 'Theme']);
    expect(bar(page.root, 'overview').getAttribute('aria-pressed')).toBe('false');
    expect(bar(page.root, 'flow').getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(0);
  });

  it('paints on Overview, and pressing it again turns the outlines off', () => {
    const page = setup();
    page.push([attach('a1', 'L1', { kind: 'query', collection: 'todos' }, [owner])]);
    bar(page.root, 'overview').click();
    expect(bar(page.root, 'overview').getAttribute('aria-pressed')).toBe('true');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);
    bar(page.root, 'overview').click();
    expect(bar(page.root, 'overview').getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(0);
  });

  it('disables Flow with the reason on a page whose renders it cannot read', () => {
    const page = setup({ react: false });
    expect(bar(page.root, 'flow').getAttribute('aria-disabled')).toBe('true');
    expect(bar(page.root, 'flow').getAttribute('title')).toContain('React');
  });

  it('singles a listener out on the page from its row, and clears it on the second press', () => {
    const page = setup();
    page.push([
      attach('a1', 'L1', { kind: 'query', collection: 'todos' }, [owner]),
      attach('a2', 'L2', { kind: 'doc', path: 'profiles/p1' }, [{ kind: 'component', name: 'Profile', element: '#profile' }]),
    ]);
    page.root.querySelector<HTMLButtonElement>('[data-listener-row="L1"]')!.click();
    expect(page.root.querySelector('[data-listener-row="L1"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(page.root.querySelector('[data-listener-row="L2"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);
    page.root.querySelector<HTMLButtonElement>('[data-listener-row="L1"]')!.click();
    expect(page.root.querySelector('[data-listener-row="L1"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(2);
  });

  it('says why nothing paints while listener attribution is off', () => {
    const page = setup({ attributionEnabled: false });
    bar(page.root, 'overview').click();
    expect(bar(page.root, 'overview').getAttribute('aria-disabled')).toBe('true');
    expect(bar(page.root, 'overview').getAttribute('title')).toContain('attribution');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(0);
  });
});
