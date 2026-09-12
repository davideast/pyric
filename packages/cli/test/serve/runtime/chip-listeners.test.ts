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

function control(root: ShadowRoot, which: 'off' | ListenerPaintMode): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-listener-mode="${which}"]`)!;
}

function rows(root: ShadowRoot): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-listener-row]')];
}

const todos = attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }]);
const profile = attach('e2', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard', element: '#profile' }]);

describe('the Listeners view', () => {
  it('gives every listener one row: the owner, its target, and its deliveries', () => {
    const page = setup();
    page.push([todos, profile]);
    page.push([delivery('d1', 'l1', { kind: 'query', collection: 'todos' })]);

    const listed = rows(page.root);
    expect(listed).toHaveLength(2);
    expect(listed[0].querySelector('.row-primary')?.textContent).toBe('TodoList todos (query)');
    expect(listed[0].querySelector('.row-secondary')?.textContent).toBe('todos (query)');
    expect(listed[0].querySelector('.row-fact')?.textContent).toBe('1');
    expect(listed[1].querySelector('.row-fact')?.textContent).toBe('0');
    page.chip.dispose();
  });

  it('falls back to the target when the only label is a frame function name', () => {
    const page = setup();
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/a.ts', line: 2, function: 'useProfile' }])]);

    const row = rows(page.root)[0];
    expect(row.textContent).not.toContain('useProfile');
    expect(row.textContent).not.toContain('l1');
    expect(row.textContent).toContain('users/u1');
    page.chip.dispose();
  });

  it('gives every row its own swatch in the listener hue', () => {
    const page = setup();
    page.push([todos, profile]);

    const swatches = page.root.querySelectorAll<HTMLElement>('[data-listener-swatch]');
    expect(swatches).toHaveLength(2);
    expect(swatches[0].getAttribute('style')).toContain('background');
    expect(swatches[0].getAttribute('style')).not.toBe(swatches[1].getAttribute('style'));
    page.chip.dispose();
  });

  it('puts a duplicate first and draws its row in the error colour', () => {
    const page = setup({
      incidents: (events) => duplicateIncidents(events, ['dup-a']),
    });
    page.push([
      attach('quiet', 'quiet-l', { kind: 'doc', path: 'users/u9' }, [{ kind: 'tag', name: 'Quiet' }]),
    ]);
    page.push([delivery('d1', 'quiet-l', { kind: 'doc', path: 'users/u9' })]);
    page.push([
      attach('dup-a', 'dup-l1', { kind: 'query', collection: 'conversations' }, [{ kind: 'tag', name: 'ChatPage' }]),
    ]);

    const listed = rows(page.root);
    expect(listed[0].getAttribute('data-listener-row')).toBe('dup-l1');
    expect(listed[0].classList.contains('problem')).toBe(true);
    expect(listed[0].getAttribute('title')).toContain('attached twice');
    expect(listed[1].classList.contains('problem')).toBe(false);
    page.chip.dispose();
  });

  it('orders the rest by deliveries and never draws more than eight', () => {
    const page = setup();
    const events: SandboxEvent[] = [];
    for (let index = 0; index < 12; index += 1) {
      events.push(attach(`a${index}`, `l${index}`, { kind: 'doc', path: `conversations/c${index}` }, [{ kind: 'tag', name: `Row${index}` }]));
    }
    page.push(events);
    page.push([delivery('d1', 'l9', { kind: 'doc', path: 'conversations/c9' })]);

    const listed = rows(page.root);
    expect(listed).toHaveLength(8);
    expect(listed[0].getAttribute('data-listener-row')).toBe('l9');
    page.chip.dispose();
  });

  it('opens the listener it stands for in Studio, and stays a plain row when Studio is off', () => {
    const withStudio = setup();
    withStudio.push([todos]);
    const row = rows(withStudio.root)[0];
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toContain('/__pyric/ui/traffic/?view=listeners&listener=l1');
    withStudio.chip.dispose();

    const withoutStudio = setup({ studioUrl: null });
    withoutStudio.push([todos]);
    expect(rows(withoutStudio.root)[0].tagName).toBe('DIV');
    withoutStudio.chip.dispose();
  });

  it('lists nothing at all when nothing is attached', () => {
    const page = setup();
    expect(rows(page.root)).toHaveLength(0);
    expect(page.root.querySelector('[data-listener-rows]')?.textContent).toBe('');
    page.chip.dispose();
  });

  it('colours the Listeners tab while a duplicate is attached', () => {
    const page = setup({ incidents: duplicateIncidents });
    expect(page.root.querySelector('[data-chip-tab="listeners"]')?.classList.contains('problem')).toBe(false);

    page.push([todos, profile]);
    expect(page.root.querySelector('[data-chip-tab="listeners"]')?.classList.contains('problem')).toBe(true);
    page.chip.dispose();
  });

  it('draws the collapsed count slot empty when the mode has reported nothing to count', () => {
    const page = setup();
    // The mode has reported, and counts no listener; a zero says nothing. The
    // slot stays, so the count arriving cannot resize the pill.
    page.push([delivery('e1', 'l1', { kind: 'doc', path: 'users/u1' })]);
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    const slot = page.root.querySelector('[data-listener-count]')!;
    expect(slot).not.toBeNull();
    expect(slot.textContent).toBe('');
    expect(slot.getAttribute('title')).toBeNull();

    page.root.querySelector<HTMLButtonElement>('[data-expand]')!.click();
    page.push([attach('e2', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'ProfileCard' }])]);
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(page.root.querySelector('[data-listener-count]')?.textContent).toBe('1');
    page.chip.dispose();
  });

  it('caps the collapsed count at three characters so the pill cannot grow', () => {
    const page = setup();
    const events: SandboxEvent[] = [];
    for (let index = 0; index < 120; index += 1) {
      events.push(attach(`a${index}`, `l${index}`, { kind: 'doc', path: `users/u${index}` }, [{ kind: 'tag', name: `Row${index}` }]));
    }
    page.push(events);
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();

    const slot = page.root.querySelector('[data-listener-count]')!;
    expect(slot.textContent).toBe('99+');
    // The title still carries the count the cap stands for.
    expect(slot.getAttribute('title')).toBe('120 listeners');
    page.chip.dispose();
  });

  it('shows the collapsed count as it stands at ninety-nine', () => {
    const page = setup();
    const events: SandboxEvent[] = [];
    for (let index = 0; index < 99; index += 1) {
      events.push(attach(`a${index}`, `l${index}`, { kind: 'doc', path: `users/u${index}` }, [{ kind: 'tag', name: `Row${index}` }]));
    }
    page.push(events);
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(page.root.querySelector('[data-listener-count]')?.textContent).toBe('99');
    page.chip.dispose();
  });

  it('shows the collapsed chip a bare listener count, red when a listener has an incident', () => {
    const page = setup({ incidents: duplicateIncidents });
    page.push([todos, profile]);
    page.root.querySelector<HTMLButtonElement>('[data-collapse]')!.click();

    const count = page.root.querySelector('[data-listener-count]')!;
    expect(count.textContent).toBe('2');
    expect(count.classList.contains('error')).toBe(true);
    expect(page.root.querySelector('.chip')?.textContent).toBe('pyric2');
    page.chip.dispose();
  });

  it('removes the overlay on dispose', () => {
    const page = setup();
    control(page.root, 'overview').click();
    page.push([todos]);
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).not.toBeNull();

    page.chip.dispose();
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
  });
});

describe('the outlines control', () => {
  it('offers off, Overview, and Flow, with off pressed on a page that has painted nothing', () => {
    const page = setup({ react: true });
    const group = page.root.querySelector('[data-listener-modes]');
    expect(group?.getAttribute('role')).toBe('group');
    expect([...group!.querySelectorAll('button')].map((button) => button.textContent))
      .toEqual(['off', 'Overview', 'Flow']);
    expect(control(page.root, 'off').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'overview').getAttribute('aria-pressed')).toBe('false');
    expect(control(page.root, 'flow').getAttribute('aria-pressed')).toBe('false');
    page.chip.dispose();
  });

  it('shows off pressed and Flow unpressed when Flow is remembered but the outlines are off', () => {
    const page = setup({ react: true, rememberedPaintMode: 'flow' });
    expect(control(page.root, 'off').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'flow').getAttribute('aria-pressed')).toBe('false');
    expect(control(page.root, 'overview').getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    page.chip.dispose();
  });

  it('paints every attached listener on Overview', () => {
    const page = setup();
    control(page.root, 'overview').click();
    page.push([todos]);

    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);
    expect(control(page.root, 'overview').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'off').getAttribute('aria-pressed')).toBe('false');
    page.chip.dispose();
  });

  it('paints deliveries on Flow, remembers the choice, and takes the Overview boxes down', () => {
    const page = setup({ react: true });
    control(page.root, 'overview').click();
    page.push([todos]);
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);

    control(page.root, 'flow').click();
    expect(control(page.root, 'flow').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'overview').getAttribute('aria-pressed')).toBe('false');
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(0);
    expect(page.paintStore.get(LISTENER_PAINT_MODE_KEY)).toBe('flow');
    page.chip.dispose();
  });

  it('clears the painting on off and leaves the remembered mode where it was', () => {
    const page = setup({ react: true });
    control(page.root, 'flow').click();
    page.push([todos]);

    control(page.root, 'off').click();
    expect(control(page.root, 'off').getAttribute('aria-pressed')).toBe('true');
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    expect(page.paintStore.get(LISTENER_PAINT_MODE_KEY)).toBe('flow');
    page.chip.dispose();
  });

  it('goes back to Overview and paints the listeners again', () => {
    const page = setup({ react: true });
    control(page.root, 'overview').click();
    page.push([todos]);
    control(page.root, 'flow').click();
    control(page.root, 'overview').click();
    expect(page.doc.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);
    page.chip.dispose();
  });

  it('disables Flow with a reason when the page has no React', () => {
    const page = setup();
    control(page.root, 'overview').click();
    page.push([todos]);

    const flow = control(page.root, 'flow');
    expect(flow.getAttribute('aria-disabled')).toBe('true');
    expect(flow.getAttribute('title')).toContain('React');

    flow.click();
    expect(control(page.root, 'overview').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'flow').getAttribute('title')).toContain('React');
    page.chip.dispose();
  });

  it('says what Flow is waiting for, and stops saying it once a flow is painted', () => {
    const page = setup({ react: true });
    control(page.root, 'overview').click();
    page.push([todos]);
    // The fact's slot is reserved either way, so the control beside it cannot
    // move when Flow starts waiting; only the words in it change.
    expect(page.root.querySelector('[data-flow-waiting]')?.textContent).toBe('');

    control(page.root, 'flow').click();
    expect(page.root.querySelector('[data-flow-waiting]')?.textContent).toContain('waiting for a delivery');

    page.flowDelivery('l1');
    expect(page.doc.querySelectorAll('[data-pyric-flow]').length).toBeGreaterThan(0);
    expect(page.root.querySelector('[data-flow-waiting]')?.textContent).toBe('');
    page.chip.dispose();
  });

  it('says it is waiting again after a turn back into Flow', () => {
    const page = setup({ react: true });
    control(page.root, 'flow').click();
    page.push([todos]);
    page.flowDelivery('l1');

    control(page.root, 'overview').click();
    expect(page.root.querySelector('[data-flow-waiting]')?.textContent).toBe('');
    control(page.root, 'flow').click();
    expect(page.root.querySelector('[data-flow-waiting]')?.textContent).toContain('waiting for a delivery');
    page.chip.dispose();
  });

  it('paints nothing and says why while listener attribution is off', () => {
    const page = setup({ attributionEnabled: false });
    control(page.root, 'overview').click();
    page.push([todos]);

    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    expect(control(page.root, 'off').getAttribute('aria-pressed')).toBe('true');
    expect(control(page.root, 'overview').getAttribute('aria-disabled')).toBe('true');
    expect(control(page.root, 'overview').getAttribute('title')).toContain('attribution is off');
    page.chip.dispose();
  });
});
