import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';

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

function harness(options: { attributionEnabled?: boolean } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="todos"></div><div id="profile"></div></body>',
    { url: 'http://localhost/' },
  );
  const doc = dom.window.document;
  let deliver: ((events: readonly SandboxEvent[]) => void) | null = null;
  let subscriptions = 0;
  const mode = createListenerMode({
    document: doc,
    attributionEnabled: () => options.attributionEnabled ?? true,
    incidents: () => [],
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
    push: (events: readonly SandboxEvent[]) => deliver?.(events),
    subscriptions: () => subscriptions,
  };
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

    expect(opened).toEqual(['/__pyric/ui/studio?view=listeners&listener=l1&target=todos']);
    mode.dispose();
  });
});
