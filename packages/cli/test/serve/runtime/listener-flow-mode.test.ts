import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { startFlowMode, type RecentDelivery } from '../../../src/serve/runtime/listener-flow-mode.js';
import type { ReactCommitSource } from '../../../src/serve/runtime/react-commit-source.js';
import type { ListenerOutline } from '../../../src/serve/runtime/listener-outline-model.js';

function outline(listenerId: string, label: string, target: string): ListenerOutline {
  return {
    listenerId,
    label,
    labelIsOwner: true,
    target,
    isQuery: true,
    service: 'firestore',
    deliveryCount: 2,
    selectors: ['#page'],
    incident: null,
  };
}

/**
 * A page with a ChatPage above a MessageThread, wired the way React wires its
 * host nodes, so the flow mode's own walk has something to read.
 */
function buildPage() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="page">
      <div id="thread"><span id="bubble">hi</span></div>
      <div id="presence"><span id="dot">1</span></div>
    </div>
  </body>`);
  const doc = dom.window.document;
  const pageEl = doc.querySelector('#page')!;
  const threadEl = doc.querySelector('#thread')!;
  const bubbleEl = doc.querySelector('#bubble')!;
  const presenceEl = doc.querySelector('#presence')!;
  const dotEl = doc.querySelector('#dot')!;

  const chatPage = { tag: 0, type: { displayName: 'ChatPage' }, return: null as unknown, child: null as unknown };
  const pageHost = { tag: 5, type: 'div', stateNode: pageEl, return: chatPage, child: null as unknown };
  const thread = { tag: 0, type: { displayName: 'MessageThread' }, return: pageHost, child: null as unknown };
  const threadHost = { tag: 5, type: 'div', stateNode: threadEl, return: thread, child: null };
  const bubbleHost = { tag: 5, type: 'span', stateNode: bubbleEl, return: threadHost, child: null };
  chatPage.child = pageHost;
  pageHost.child = thread;
  thread.child = threadHost;
  (threadHost as { child: unknown }).child = bubbleHost;
  // The presence bar is inline JSX: its host fibers hang off the page's own
  // host node with no component of their own in between.
  const presenceHost = { tag: 5, type: 'div', stateNode: presenceEl, return: pageHost, child: null as unknown };
  const dotHost = { tag: 5, type: 'span', stateNode: dotEl, return: presenceHost, child: null };
  presenceHost.child = dotHost;
  (thread as { sibling?: unknown }).sibling = presenceHost;

  (pageEl as unknown as Record<string, unknown>)['__reactFiber$k'] = pageHost;
  (threadEl as unknown as Record<string, unknown>)['__reactFiber$k'] = threadHost;
  (bubbleEl as unknown as Record<string, unknown>)['__reactFiber$k'] = bubbleHost;
  (presenceEl as unknown as Record<string, unknown>)['__reactFiber$k'] = presenceHost;
  (dotEl as unknown as Record<string, unknown>)['__reactFiber$k'] = dotHost;

  return { doc, pageEl, threadEl, bubbleEl, presenceEl, dotEl };
}

/** Every element Flow has marked, in document order. */
function marked(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-pyric-flow]')];
}

/** What each marked element says it is. */
function labels(doc: Document): (string | null)[] {
  return marked(doc).map((element) => element.getAttribute('data-pyric-flow-label'));
}

interface SetupOptions {
  visible?: (listenerId: string) => boolean;
  recentDeliveries?: () => readonly RecentDelivery[];
  replayWindowMs?: number;
  now?: () => number;
  onPaint?: (listenerId: string) => void;
}

function setup(options: SetupOptions = {}) {
  const page = buildPage();
  const container = page.doc.createElement('div');
  page.doc.body.append(container);

  let commit: (() => void) | null = null;
  const commits: ReactCommitSource = {
    available: () => true,
    reason: () => null,
    subscribe: (listener) => {
      commit = listener;
      return () => {
        commit = null;
      };
    },
    dispose: () => {},
  };

  let deliver: ((listenerId: string) => void) | null = null;
  let changed: unknown[] = [];
  const outlines = new Map([
    ['sub-1', outline('sub-1', 'ChatPage', 'conversations/c1/messages')],
  ]);

  const mode = startFlowMode({
    document: page.doc,
    container,
    commits,
    outlineFor: (listenerId) => outlines.get(listenerId) ?? null,
    isVisible: options.visible ?? (() => true),
    subscribeDeliveries: (listener) => {
      deliver = listener;
      return () => {
        deliver = null;
      };
    },
    changedNodes: () => ({
      drain: () => {
        const drained = changed;
        changed = [];
        return drained;
      },
      stop: () => {},
    }),
    ...(options.recentDeliveries === undefined ? {} : { recentDeliveries: options.recentDeliveries }),
    ...(options.replayWindowMs === undefined ? {} : { replayWindowMs: options.replayWindowMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onPaint === undefined ? {} : { onPaint: options.onPaint }),
  });

  return {
    ...page,
    container,
    mode,
    outlines,
    deliver: (listenerId: string) => deliver?.(listenerId),
    change: (nodes: unknown[]) => {
      changed = nodes;
    },
    commit: () => commit?.(),
  };
}

describe('the Flow painting mode', () => {
  it('paints the components that rendered after a delivery', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();

    expect(marked(page.doc)).toEqual([page.threadEl as HTMLElement]);
    expect(labels(page.doc)).toEqual(['ChatPage · conversations/c1/messages (query) · 2']);
    page.mode.dispose();
  });

  it('never marks the registered region or the owner that registered it', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();

    // The owner is named in the label rather than outlined, and the region it
    // registered is the whole area the listener feeds rather than something
    // that changed, so neither carries a mark.
    expect(page.pageEl.hasAttribute('data-pyric-flow')).toBe(false);
    expect(page.threadEl.getAttribute('data-pyric-flow-role')).toBe('component');
    expect(page.container.children).toHaveLength(1);
  });

  it('marks a changed element by itself when no component sits between it and the root', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.presenceEl]);
    page.commit();

    expect(page.presenceEl.getAttribute('data-pyric-flow-role')).toBe('host');
    expect(labels(page.doc)).toEqual(['ChatPage · conversations/c1/messages (query) · 2']);
  });

  it('collapses a changed subtree to the element at its top', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.presenceEl, page.dotEl]);
    page.commit();

    expect(marked(page.doc)).toEqual([page.presenceEl as HTMLElement]);
  });

  it('replays the last delivery on the switch when it is inside the window', () => {
    const page = setup({
      now: () => 10_000,
      replayWindowMs: 5000,
      recentDeliveries: () => [{ listenerId: 'sub-1', at: 8000 }],
    });

    // A replay has no changed nodes to read, so the registered element is the
    // one claim the fold supports, and it carries the full label.
    expect(marked(page.doc)).toEqual([page.pageEl as HTMLElement]);
    expect(labels(page.doc)).toEqual(['ChatPage · conversations/c1/messages (query) · 2']);
  });

  it('replays nothing for a delivery older than the window', () => {
    const page = setup({
      now: () => 10_000,
      replayWindowMs: 5000,
      recentDeliveries: () => [{ listenerId: 'sub-1', at: 1000 }],
    });

    expect(marked(page.doc)).toHaveLength(0);
  });

  it('reports the outline own listener id when it paints, whatever id the delivery carried', () => {
    const painted: string[] = [];
    const page = setup({ onPaint: (listenerId) => painted.push(listenerId) });
    page.outlines.set('client-9', { ...page.outlines.get('sub-1')!, clientListenerId: 'client-9' });
    page.deliver('client-9');
    page.change([page.bubbleEl]);
    page.commit();

    expect(painted).toEqual(['sub-1']);
    expect(marked(page.doc).every((element) => (
      element.getAttribute('data-pyric-flow-listener') === 'sub-1'
    ))).toBe(true);
  });

  it('drains the observer before it closes the window, so a commit sees its own changes', () => {
    const page = setup();
    page.deliver('sub-1');
    // The nodes are queued the way a MutationObserver queues them: available
    // to a drain, never pushed at the mode.
    page.change([page.bubbleEl]);
    page.commit();
    expect(marked(page.doc).length).toBeGreaterThan(0);
    page.mode.dispose();
  });

  it('paints nothing for a commit no delivery preceded', () => {
    const page = setup();
    page.change([page.bubbleEl]);
    page.commit();
    expect(marked(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing for a listener that is switched off', () => {
    const page = setup({ visible: () => false });
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    expect(marked(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing for a listener the fold does not know', () => {
    const page = setup();
    page.deliver('sub-unknown');
    page.change([page.bubbleEl]);
    page.commit();
    expect(marked(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing when the changed nodes belong to no React component', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.doc.createElement('div')]);
    page.commit();
    expect(marked(page.doc)).toHaveLength(0);
    page.mode.dispose();
  });

  it('takes one listener marks away on request and everything on dispose', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    page.mode.clearListener('sub-1');
    expect(marked(page.doc)).toHaveLength(0);
    expect(page.doc.querySelectorAll('[data-pyric-flow-label]')).toHaveLength(0);

    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    page.mode.dispose();
    expect(marked(page.doc)).toHaveLength(0);
    expect(page.doc.querySelectorAll('[data-pyric-flow-label]')).toHaveLength(0);
  });

  it('reads the page own changes through a MutationObserver by default', () => {
    const page = buildPage();
    const container = page.doc.createElement('div');
    page.doc.body.append(container);
    let commit: (() => void) | null = null;
    let deliver: ((listenerId: string) => void) | null = null;
    const mode = startFlowMode({
      document: page.doc,
      container,
      commits: {
        available: () => true,
        reason: () => null,
        subscribe: (listener) => {
          commit = listener;
          return () => {};
        },
        dispose: () => {},
      },
      outlineFor: () => outline('sub-1', 'ChatPage', 'conversations/c1/messages'),
      isVisible: () => true,
      subscribeDeliveries: (listener) => {
        deliver = listener;
        return () => {};
      },
    });

    deliver!('sub-1');
    page.bubbleEl.textContent = 'two';
    commit!();

    expect(marked(page.doc)).toEqual([page.threadEl as HTMLElement]);
    mode.dispose();
  });

  it('ignores the chip own chrome', () => {
    const page = buildPage();
    const container = page.doc.createElement('div');
    page.doc.body.append(container);
    let commit: (() => void) | null = null;
    let deliver: ((listenerId: string) => void) | null = null;
    const mode = startFlowMode({
      document: page.doc,
      container,
      commits: {
        available: () => true,
        reason: () => null,
        subscribe: (listener) => {
          commit = listener;
          return () => {};
        },
        dispose: () => {},
      },
      outlineFor: () => outline('sub-1', 'ChatPage', 'conversations/c1/messages'),
      isVisible: () => true,
      subscribeDeliveries: (listener) => {
        deliver = listener;
        return () => {};
      },
    });

    deliver!('sub-1');
    const chipHost = page.doc.createElement('div');
    chipHost.setAttribute('data-pyric-runtime-chip-host', '');
    page.doc.body.append(chipHost);
    chipHost.textContent = 'chip';
    container.append(page.doc.createElement('span'));
    commit!();

    expect(marked(page.doc)).toHaveLength(0);
    mode.dispose();
  });

  it('stops listening for deliveries and commits once disposed', () => {
    const page = setup();
    page.mode.dispose();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    expect(marked(page.doc)).toHaveLength(0);
  });
});
