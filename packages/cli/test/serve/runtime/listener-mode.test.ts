import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  createListenerMode,
  studioListenerUrl,
  studioListenersUrl,
} from '../../../src/serve/runtime/listener-mode.js';

type Target = { kind: 'doc'; path: string } | { kind: 'query'; collection: string };

const auth = { uid: null, token: null };

function attach(id: string, listenerId: string, target: Target, owners: unknown[]): SandboxEvent {
  return { kind: 'listener_attach', id, at: 1, listenerId, target, auth, owners } as unknown as SandboxEvent;
}

function detach(id: string, listenerId: string, target: Target): SandboxEvent {
  return { kind: 'listener_detach', id, at: 5, listenerId, target, auth } as unknown as SandboxEvent;
}

function delivery(id: string, listenerId: string, target: Target, owners?: unknown[]): SandboxEvent {
  const event: Record<string, unknown> = {
    kind: 'snapshot_delivery',
    id,
    at: 2,
    listenerId,
    target,
    auth,
    addedCount: 1,
    modifiedCount: 0,
    removedCount: 0,
    size: 1,
  };
  if (owners !== undefined) event.owners = owners;
  return event as unknown as SandboxEvent;
}

/** A commit source that reports a React the test drives. */
function fakeCommits(available: boolean) {
  let commit: (() => void) | null = null;
  return {
    source: {
      available: () => available,
      reason: () => (available ? null : 'no React'),
      subscribe: (listener: () => void) => {
        commit = listener;
        return () => {
          commit = null;
        };
      },
      dispose: () => {},
    },
    fire: () => commit?.(),
    subscribed: () => commit !== null,
  };
}

function harness(options: {
  attributionEnabled?: boolean;
  react?: boolean;
  paintStorage?: Parameters<typeof createListenerMode>[0]['paintStorage'];
} = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="todos"><span id="row">a</span></div><div id="profile"></div></body>',
    { url: 'http://localhost/' },
  );
  const doc = dom.window.document;
  // A row inside the todos region, wired the way React wires a host node it
  // rendered inline: nothing between it and the region is a component.
  const rowEl = doc.querySelector('#row')!;
  const regionHost = { tag: 5, type: 'div', stateNode: doc.querySelector('#todos')!, return: null, child: null };
  const rowHost = { tag: 5, type: 'span', stateNode: rowEl, return: regionHost, child: null };
  (rowEl as unknown as Record<string, unknown>)['__reactFiber$k'] = rowHost;
  let changedNodes: unknown[] = [];
  let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
  let subscriptions = 0;
  let delivered: ((listenerId: string) => void) | null = null;
  const commits = fakeCommits(options.react ?? true);
  const mode = createListenerMode({
    document: doc,
    attributionEnabled: () => options.attributionEnabled ?? true,
    incidents: () => [],
    commits: commits.source,
    paintStorage: options.paintStorage ?? null,
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
      subscriptions += 1;
      deliver = callback;
      return () => {
        subscriptions -= 1;
        deliver = null;
      };
    },
  });
  return {
    doc,
    mode,
    commits,
    rowEl,
    push: (events: readonly SandboxEvent[]) => deliver?.(events),
    subscriptions: () => subscriptions,
    flowWatching: () => delivered !== null,
    /** A delivery the worker client reported, and the render that followed. */
    flowDelivery: (listenerId: string, nodes: unknown[]) => {
      delivered?.(listenerId);
      changedNodes = nodes;
      commits.fire();
    },
  };
}

function flowMarks(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-pyric-flow]')];
}

function badges(doc: Document): string[] {
  return [...doc.querySelectorAll('[data-pyric-listener-badge]')].map((badge) => badge.textContent ?? '');
}

describe('createListenerMode', () => {
  it('outlines a tagged listener and a region-owned listener with labels and counts', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }]),
      delivery('e2', 'l1', { kind: 'query', collection: 'todos' }),
      attach('e3', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/profile.ts', line: 4, function: 'Profile' }]),
      delivery('e4', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'regions', selectors: ['#profile'] }]),
    ]);

    const drawn = badges(page.doc);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]).toContain('TodoList');
    expect(drawn[0]).toContain('todos (query)');
    expect(drawn[0]).toContain('1');
    expect(drawn[1]).toContain('Profile');
    expect(drawn[1]).toContain('users/u1');
    page.mode.dispose();
  });

  it('removes an outline when its listener detaches', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([
      attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }]),
      attach('e2', 'l2', { kind: 'doc', path: 'users/u1' }, [{ kind: 'tag', name: 'Profile', element: '#profile' }]),
    ]);
    expect(badges(page.doc)).toHaveLength(2);

    page.push([detach('e3', 'l2', { kind: 'doc', path: 'users/u1' })]);
    expect(badges(page.doc)).toHaveLength(1);
    expect(badges(page.doc)[0]).toContain('TodoList');
    page.mode.dispose();
  });

  it('lists a listener with no page geometry as unattributed', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([attach('e1', 'l1', { kind: 'doc', path: 'users/u1' }, [{ kind: 'frame', file: '/src/a.ts', line: 3 }])]);

    expect(badges(page.doc)).toHaveLength(0);
    expect(page.mode.unattributed().map((outline) => outline.label)).toEqual(['/src/a.ts']);
    page.mode.dispose();
  });

  it('draws nothing while listener attribution is off', () => {
    const page = harness({ attributionEnabled: false });
    page.mode.setEnabled(true);
    page.push([attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }])]);

    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    expect(page.mode.enabled()).toBe(false);
    page.mode.dispose();
  });

  it('observes events from creation and only outlines while the mode is on', () => {
    const page = harness();
    expect(page.subscriptions()).toBe(1);
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    page.mode.setEnabled(true);
    expect(page.subscriptions()).toBe(1);
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).not.toBeNull();
    page.mode.setEnabled(false);
    expect(page.subscriptions()).toBe(1);
    expect(page.doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
    page.mode.dispose();
    expect(page.subscriptions()).toBe(0);
  });
});

describe('incident marking', () => {
  it('marks the badges of listeners the activity monitor calls duplicates', () => {
    const dom = new JSDOM('<!doctype html><body><div id="a"></div><div id="b"></div><div id="c"></div></body>', { url: 'http://localhost/' });
    const doc = dom.window.document;
    let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
    const mode = createListenerMode({
      document: doc,
      attributionEnabled: () => true,
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {};
      },
    });
    mode.setEnabled(true);
    const appAuth = { uid: 'u1', token: { uid: 'u1' } };
    const attaches = ['a', 'b', 'c'].map((name, index) => ({
      kind: 'listener_attach',
      id: `e${index}`,
      at: index + 1,
      listenerId: `l${index}`,
      target: { kind: 'query', collection: 'todos' },
      auth: appAuth,
      actor: { kind: 'app' },
      owners: [{ kind: 'tag', name, element: `#${name}` }],
    } as unknown as SandboxEvent));
    deliver?.(attaches);

    const marked = [...doc.querySelectorAll<HTMLElement>('[data-pyric-listener-badge]')];
    expect(marked).toHaveLength(3);
    for (const badge of marked) {
      expect(badge.dataset.incident).toBe('duplicate-listener');
      expect(badge.textContent).toContain('duplicate ×3');
    }
    mode.dispose();
  });
});

describe('studio hand-off', () => {
  it('opens the Studio listeners view filtered to the clicked listener', () => {
    const dom = new JSDOM('<!doctype html><body><div id="todos"></div></body>', { url: 'http://localhost/' });
    const doc = dom.window.document;
    const opened: string[] = [];
    let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
    const mode = createListenerMode({
      document: doc,
      attributionEnabled: () => true,
      incidents: () => [],
      studioUrl: '/__pyric/ui/studio',
      openStudio: (url) => opened.push(url),
      subscribeEvents: (callback) => {
        deliver = callback;
        return () => {};
      },
    });
    mode.setEnabled(true);
    deliver?.([attach('e1', 'l1', { kind: 'query', collection: 'todos' }, [{ kind: 'tag', name: 'TodoList', element: '#todos' }])]);
    doc.querySelector<HTMLElement>('[data-pyric-listener-badge]')?.click();

    expect(opened).toEqual(['/__pyric/ui/traffic/?view=listeners&listener=l1&target=todos']);
    mode.dispose();
  });
});

const todosAttach = attach(
  'e1',
  'l1',
  { kind: 'query', collection: 'todos' },
  [{ kind: 'tag', name: 'TodoList', element: '#todos' }],
);
const profileAttach = attach(
  'e3',
  'l2',
  { kind: 'doc', path: 'users/u1' },
  [{ kind: 'tag', name: 'ProfileCard', element: '#profile' }],
);

function boxes(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-pyric-listener-box]')];
}

describe('the two painting modes', () => {
  it('starts in Overview and paints one box per listener', () => {
    const page = harness();
    expect(page.mode.mode()).toBe('overview');
    page.mode.setEnabled(true);
    page.push([todosAttach, profileAttach]);
    expect(boxes(page.doc)).toHaveLength(2);
    page.mode.dispose();
  });

  it('gives each listener its own colour', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach, profileAttach]);
    const drawn = boxes(page.doc);
    expect(drawn[0].dataset.hue).not.toBe(undefined);
    expect(drawn[0].dataset.hue).not.toBe(drawn[1].dataset.hue);
    page.mode.dispose();
  });

  it('takes the Overview boxes down when it switches to Flow, and watches for deliveries', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach]);
    expect(boxes(page.doc)).toHaveLength(1);

    page.mode.setMode('flow');
    expect(page.mode.mode()).toBe('flow');
    expect(boxes(page.doc)).toHaveLength(0);
    expect(page.flowWatching()).toBe(true);
    page.mode.dispose();
  });

  it('brings the Overview boxes back and stops watching when it switches back', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach]);
    page.mode.setMode('flow');
    page.mode.setMode('overview');

    expect(boxes(page.doc)).toHaveLength(1);
    expect(page.flowWatching()).toBe(false);
    page.mode.dispose();
  });

  it('keeps the mode across a turn of the painting off and on', () => {
    const page = harness();
    page.mode.setMode('flow');
    page.mode.setEnabled(true);
    page.push([todosAttach]);
    expect(boxes(page.doc)).toHaveLength(0);
    expect(page.flowWatching()).toBe(true);

    page.mode.setEnabled(false);
    expect(page.flowWatching()).toBe(false);
    page.mode.setEnabled(true);
    expect(page.mode.mode()).toBe('flow');
    expect(page.flowWatching()).toBe(true);
    page.mode.dispose();
  });

  it('refuses Flow and says why when the page has no React', () => {
    const page = harness({ react: false });
    expect(page.mode.flowAvailable()).toBe(false);
    expect(page.mode.flowUnavailableReason()).toContain('React');

    page.mode.setMode('flow');
    expect(page.mode.mode()).toBe('overview');
    page.mode.dispose();
  });

  it('remembers the mode where the page keeps it', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const first = harness({ paintStorage: storage });
    first.mode.setMode('flow');
    first.mode.dispose();

    const second = harness({ paintStorage: storage });
    expect(second.mode.mode()).toBe('flow');
    second.mode.dispose();
  });
});

describe('switching one listener off', () => {
  it('stops painting that listener and leaves the others', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach, profileAttach]);

    page.mode.setListenerVisible('l1', false);
    const drawn = boxes(page.doc);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].dataset.listenerId).toBe('l2');
    expect(page.mode.isListenerVisible('l1')).toBe(false);
    expect(page.mode.isListenerVisible('l2')).toBe(true);
    page.mode.dispose();
  });

  it('paints it again when it is switched back on', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach, profileAttach]);
    page.mode.setListenerVisible('l1', false);
    page.mode.setListenerVisible('l1', true);
    expect(boxes(page.doc)).toHaveLength(2);
    page.mode.dispose();
  });

  it('keeps the listener in the panel summary while its paint is off', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach, profileAttach]);
    page.mode.setListenerVisible('l1', false);
    expect(page.mode.outlines()).toHaveLength(2);
    page.mode.dispose();
  });

  it('forgets which listeners were off once the mode is disposed', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach]);
    page.mode.setListenerVisible('l1', false);
    page.mode.dispose();
    expect(page.mode.isListenerVisible('l1')).toBe(true);
  });
});

describe('what a painted flow is held for', () => {
  /** A mode in Flow with one delivery painted: the changed row. */
  function painted() {
    const page = harness();
    page.mode.setEnabled(true);
    page.mode.setMode('flow');
    page.push([todosAttach]);
    page.flowDelivery('l1', [page.rowEl]);
    return page;
  }

  it('marks the changed row itself, and holds it after the delivery', () => {
    const page = painted();
    const drawn = flowMarks(page.doc);
    expect(drawn).toEqual([page.rowEl as HTMLElement]);
    expect(drawn[0]?.getAttribute('data-pyric-flow-role')).toBe('host');
    expect(drawn.every((mark) => mark.getAttribute('data-pyric-flow-listener') === 'l1')).toBe(true);
    page.mode.dispose();
  });

  it('takes the held paint away as soon as the listener is switched off', () => {
    const page = painted();
    page.mode.setListenerVisible('l1', false);
    expect(flowMarks(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('leaves the page empty after a switch back on, until the next delivery', () => {
    const page = painted();
    page.mode.setListenerVisible('l1', false);
    page.mode.setListenerVisible('l1', true);
    expect(flowMarks(page.doc)).toHaveLength(0);

    page.flowDelivery('l1', [page.rowEl]);
    expect(flowMarks(page.doc)).toHaveLength(1);
    page.mode.dispose();
  });

  it('takes the held paint away when the listener detaches', () => {
    const page = painted();
    page.push([detach('e9', 'l1', { kind: 'query', collection: 'todos' })]);
    expect(flowMarks(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('says it is waiting for a delivery until one has been painted', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.mode.setMode('flow');
    page.push([todosAttach]);
    expect(page.mode.flowWaiting()).toBe(true);

    page.flowDelivery('l1', [page.rowEl]);
    expect(page.mode.flowWaiting()).toBe(false);
    page.mode.dispose();
  });

  it('is not waiting while Overview is the mode', () => {
    const page = harness();
    page.mode.setEnabled(true);
    page.push([todosAttach]);
    expect(page.mode.flowWaiting()).toBe(false);
    page.mode.dispose();
  });

  it('waits again after a turn back into Flow', () => {
    const page = painted();
    page.mode.setMode('overview');
    page.mode.setMode('flow');
    expect(page.mode.flowWaiting()).toBe(true);
    page.mode.dispose();
  });
});

describe('the chip\'s Studio Listeners link', () => {
  it('names the Traffic route with a trailing slash so no redirect drops the query', () => {
    expect(studioListenersUrl('/__pyric/ui/studio')).toBe('/__pyric/ui/traffic/?view=listeners');
    expect(studioListenersUrl('/__pyric/ui/studio/')).toBe('/__pyric/ui/traffic/?view=listeners');
  });

  it('keeps a query the Studio URL already carries', () => {
    expect(studioListenersUrl('/__pyric/ui/studio?theme=dark')).toBe(
      '/__pyric/ui/traffic/?theme=dark&view=listeners',
    );
  });

  it('filters to one listener off the same base', () => {
    expect(
      studioListenerUrl('/__pyric/ui/studio', {
        listenerId: 'l 1',
        target: 'notes/astro-host',
      } as Parameters<typeof studioListenerUrl>[1]),
    ).toBe('/__pyric/ui/traffic/?view=listeners&listener=l%201&target=notes%2Fastro-host');
  });
});
