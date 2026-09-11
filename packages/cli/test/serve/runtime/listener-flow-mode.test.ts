import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { startFlowMode } from '../../../src/serve/runtime/listener-flow-mode.js';
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
    <div id="page"><div id="thread"><span id="bubble">hi</span></div></div>
  </body>`);
  const doc = dom.window.document;
  const pageEl = doc.querySelector('#page')!;
  const threadEl = doc.querySelector('#thread')!;
  const bubbleEl = doc.querySelector('#bubble')!;

  const chatPage = { tag: 0, type: { displayName: 'ChatPage' }, return: null as unknown, child: null as unknown };
  const pageHost = { tag: 5, type: 'div', stateNode: pageEl, return: chatPage, child: null as unknown };
  const thread = { tag: 0, type: { displayName: 'MessageThread' }, return: pageHost, child: null as unknown };
  const threadHost = { tag: 5, type: 'div', stateNode: threadEl, return: thread, child: null };
  const bubbleHost = { tag: 5, type: 'span', stateNode: bubbleEl, return: threadHost, child: null };
  chatPage.child = pageHost;
  pageHost.child = thread;
  thread.child = threadHost;
  (threadHost as { child: unknown }).child = bubbleHost;
  (pageEl as unknown as Record<string, unknown>)['__reactFiber$k'] = pageHost;
  (threadEl as unknown as Record<string, unknown>)['__reactFiber$k'] = threadHost;
  (bubbleEl as unknown as Record<string, unknown>)['__reactFiber$k'] = bubbleHost;

  return { doc, pageEl, threadEl, bubbleEl };
}

function setup(options: { visible?: (listenerId: string) => boolean } = {}) {
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

    const boxes = [...page.container.querySelectorAll<HTMLElement>('[data-pyric-flow-box]')];
    expect(boxes.map((box) => box.dataset.component)).toEqual(['ChatPage', 'MessageThread']);
    expect(page.container.querySelector('[data-pyric-flow-badge]')?.textContent)
      .toBe('ChatPage · conversations/c1/messages (query) · 2');
    page.mode.dispose();
  });

  it('drains the observer before it closes the window, so a commit sees its own changes', () => {
    const page = setup();
    page.deliver('sub-1');
    // The nodes are queued the way a MutationObserver queues them: available
    // to a drain, never pushed at the mode.
    page.change([page.bubbleEl]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]').length).toBeGreaterThan(0);
    page.mode.dispose();
  });

  it('paints nothing for a commit no delivery preceded', () => {
    const page = setup();
    page.change([page.bubbleEl]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing for a listener that is switched off', () => {
    const page = setup({ visible: () => false });
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing for a listener the fold does not know', () => {
    const page = setup();
    page.deliver('sub-unknown');
    page.change([page.bubbleEl]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    page.mode.dispose();
  });

  it('paints nothing when the changed nodes belong to no React component', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.doc.createElement('div')]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    page.mode.dispose();
  });

  it('takes one listener boxes away on request and everything on dispose', () => {
    const page = setup();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    page.mode.clearListener('sub-1');
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);

    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    page.mode.dispose();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
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

    const boxes = [...container.querySelectorAll<HTMLElement>('[data-pyric-flow-box]')];
    expect(boxes.map((box) => box.dataset.component)).toEqual(['ChatPage', 'MessageThread']);
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

    expect(container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    mode.dispose();
  });

  it('stops listening for deliveries and commits once disposed', () => {
    const page = setup();
    page.mode.dispose();
    page.deliver('sub-1');
    page.change([page.bubbleEl]);
    page.commit();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
  });
});
