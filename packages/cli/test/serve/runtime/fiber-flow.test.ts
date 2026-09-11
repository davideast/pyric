import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import {
  componentChain,
  componentName,
  fiberFromNode,
  flowSubtree,
  hostElementFor,
  isNamedComponent,
  nearestFiber,
  regionSubtree,
  type FiberLike,
} from '../../../src/serve/runtime/fiber-flow.js';

/**
 * A fiber-shaped fixture. React is not a dependency of this package, so the
 * walk is exercised against the same field names React writes: `tag`, `type`,
 * `stateNode`, `return`, `child`, and `sibling`, plus the `__reactFiber$`
 * property React puts on host nodes.
 */
interface MutableFiber {
  tag: number;
  type: unknown;
  stateNode: unknown;
  return: MutableFiber | null;
  child: MutableFiber | null;
  sibling: MutableFiber | null;
}

function component(name: string): MutableFiber {
  const type = { displayName: name };
  return { tag: 0, type, stateNode: null, return: null, child: null, sibling: null };
}

function host(element: Element): MutableFiber {
  return { tag: 5, type: element.tagName.toLowerCase(), stateNode: element, return: null, child: null, sibling: null };
}

function appendChild(parent: MutableFiber, child: MutableFiber): MutableFiber {
  child.return = parent;
  if (parent.child === null) {
    parent.child = child;
    return child;
  }
  let last = parent.child;
  while (last.sibling !== null) last = last.sibling;
  last.sibling = child;
  return child;
}

/** Attach a fiber to its host node the way React does. */
function link(element: Element, fiber: MutableFiber): void {
  (element as unknown as Record<string, unknown>)['__reactFiber$abc123'] = fiber;
}

/**
 * ChatPage
 *   ConversationList  -> #list, with an #item inside it
 *   MessageThread     -> #thread, with a #bubble inside it
 *   #bar              -> inline JSX, with a .conversation chip inside it
 *
 * The #bar branch is what the chat template looks like: the page component
 * renders it directly, so nothing between the page root and those elements is
 * a component of its own.
 */
function buildPage() {
  const dom = new JSDOM(`<!doctype html><body><div id="page">
    <div id="list"><span id="item">one</span></div>
    <div id="thread"><span id="bubble">hi</span></div>
    <div id="bar"><span class="conversation pinned">c</span></div>
  </div></body>`);
  const doc = dom.window.document;
  const pageEl = doc.querySelector('#page')!;
  const listEl = doc.querySelector('#list')!;
  const itemEl = doc.querySelector('#item')!;
  const threadEl = doc.querySelector('#thread')!;
  const bubbleEl = doc.querySelector('#bubble')!;
  const barEl = doc.querySelector('#bar')!;
  const chipEl = doc.querySelector('.conversation')!;

  const chatPage = component('ChatPage');
  const pageHost = appendChild(chatPage, host(pageEl));
  const list = appendChild(pageHost, component('ConversationList'));
  const listHost = appendChild(list, host(listEl));
  const itemHost = appendChild(listHost, host(itemEl));
  const thread = appendChild(pageHost, component('MessageThread'));
  const threadHost = appendChild(thread, host(threadEl));
  const bubbleHost = appendChild(threadHost, host(bubbleEl));

  const barHost = appendChild(pageHost, host(barEl));
  const chipHost = appendChild(barHost, host(chipEl));

  link(pageEl, pageHost);
  link(listEl, listHost);
  link(itemEl, itemHost);
  link(threadEl, threadHost);
  link(bubbleEl, bubbleHost);
  link(barEl, barHost);
  link(chipEl, chipHost);

  return { doc, pageEl, listEl, itemEl, threadEl, bubbleEl, barEl, chipEl, chatPage, list, thread };
}

describe('reading a fiber off a node', () => {
  it('finds the fiber React attached under its random suffix', () => {
    const page = buildPage();
    expect(fiberFromNode(page.listEl)).not.toBeNull();
  });

  it('returns null for a node React never touched', () => {
    const page = buildPage();
    expect(fiberFromNode(page.doc.createElement('div'))).toBeNull();
    expect(fiberFromNode(null)).toBeNull();
    expect(fiberFromNode('text')).toBeNull();
  });

  it('climbs to the nearest node React did create', () => {
    const page = buildPage();
    const text = page.bubbleEl.firstChild;
    expect(nearestFiber(text)).not.toBeNull();
    expect(hostElementFor(nearestFiber(text)!)).toBe(page.bubbleEl);
  });
});

describe('naming a component fiber', () => {
  it('prefers displayName and falls back to the function name', () => {
    function MessageRow(): null {
      return null;
    }
    const named: FiberLike = { tag: 0, type: MessageRow };
    expect(componentName(named)).toBe('MessageRow');
    expect(componentName({ tag: 0, type: { displayName: 'Wrapped', name: 'inner' } })).toBe('Wrapped');
  });

  it('reads through a memo or forwardRef wrapper', () => {
    function PresenceBar(): null {
      return null;
    }
    expect(componentName({ tag: 14, type: { type: PresenceBar } })).toBe('PresenceBar');
    expect(componentName({ tag: 11, type: { render: PresenceBar } })).toBe('PresenceBar');
  });

  it('names no host component and no unnamed type', () => {
    expect(componentName({ tag: 5, type: 'div' })).toBeNull();
    expect(componentName({ tag: 0, type: null })).toBeNull();
    expect(isNamedComponent({ tag: 5, type: 'div' })).toBe(false);
    expect(isNamedComponent({ tag: 0, type: { displayName: 'ChatPage' } })).toBe(true);
  });
});

describe('the component chain above a node', () => {
  it('lists every component from the root down to the node, outermost first', () => {
    const page = buildPage();
    const chain = componentChain(fiberFromNode(page.itemEl)!);
    expect(chain.map((fiber) => componentName(fiber))).toEqual(['ChatPage', 'ConversationList']);
  });

  it('gives each component the first host element below it', () => {
    const page = buildPage();
    expect(hostElementFor(page.chatPage)).toBe(page.pageEl);
    expect(hostElementFor(page.list)).toBe(page.listEl);
    expect(hostElementFor(page.thread)).toBe(page.threadEl);
  });

  it('borrows the nearest host node above a component that renders none', () => {
    const page = buildPage();
    const empty = appendChild(fiberFromNode(page.threadEl)! as MutableFiber, component('Empty'));
    expect(hostElementFor(empty)).toBe(page.threadEl);
  });
});

describe('the subtree a delivery rendered', () => {
  it('names the owner at the root and the component that changed as a leaf', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.bubbleEl]);
    expect(subtree.root?.name).toBe('ChatPage');
    expect(subtree.root?.element).toBe(page.pageEl);
    expect(subtree.components.map((entry) => entry.name)).toEqual(['ChatPage', 'MessageThread']);
    expect(subtree.leaves.map((entry) => entry.name)).toEqual(['MessageThread']);
  });

  it('joins two mutated branches under one root', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.bubbleEl, page.itemEl]);
    expect(subtree.root?.name).toBe('ChatPage');
    expect(subtree.components.map((entry) => entry.name).sort())
      .toEqual(['ChatPage', 'ConversationList', 'MessageThread']);
    expect(subtree.leaves.map((entry) => entry.name).sort())
      .toEqual(['ConversationList', 'MessageThread']);
    expect(subtree.components.filter((entry) => entry.depth === 0)).toHaveLength(1);
  });

  it('counts a component once when the same render is reported twice', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.bubbleEl, page.bubbleEl, page.threadEl]);
    expect(subtree.components.map((entry) => entry.name)).toEqual(['ChatPage', 'MessageThread']);
  });

  it('names nothing when no mutated node belongs to React', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.doc.createElement('div')]);
    expect(subtree.root).toBeNull();
    expect(subtree.components).toHaveLength(0);
    expect(subtree.leaves).toHaveLength(0);
  });

  it('marks neither the registered region nor the named owner', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.bubbleEl], {
      regionElement: page.pageEl,
      ownerName: 'ChatPage',
    });
    // ChatPage's own host node is the page root, which is also the region: the
    // first label names the owner instead of outlining the whole page.
    expect(subtree.components.some((entry) => entry.element === page.pageEl)).toBe(false);
    expect(subtree.components.map((entry) => entry.name)).toEqual(['MessageThread']);
    expect(subtree.root?.element).toBe(page.threadEl);
    expect(subtree.root?.kind).toBe('component');
  });

  it('leaves the region unmarked even when the owner label is not one the app gave', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.bubbleEl], { regionElement: page.pageEl });
    expect(subtree.components.some((entry) => entry.element === page.pageEl)).toBe(false);
  });

  it('makes a changed node its own mark when only the owner sits above it', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.barEl], {
      regionElement: page.pageEl,
      ownerName: 'ChatPage',
    });
    expect(subtree.components).toHaveLength(1);
    expect(subtree.components[0]?.kind).toBe('host');
    expect(subtree.components[0]?.name).toBe('div#bar');
    expect(subtree.components[0]?.element).toBe(page.barEl);
  });

  it('labels a changed element by its first class when it carries no id', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.chipEl], {
      regionElement: page.pageEl,
      ownerName: 'ChatPage',
    });
    expect(subtree.components.map((entry) => entry.name)).toEqual(['span.conversation']);
  });

  it('collapses nested changed nodes to the one at the top', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.chipEl, page.barEl], {
      regionElement: page.pageEl,
      ownerName: 'ChatPage',
    });
    expect(subtree.components.map((entry) => entry.name)).toEqual(['div#bar']);
  });

  it('draws nothing when the delivery changed nothing the walk could attribute', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.doc.createElement('div')], {
      regionElement: page.pageEl,
      ownerName: 'ChatPage',
    });
    expect(subtree.root).toBeNull();
    expect(subtree.components).toHaveLength(0);
  });

  it('marks the registered element alone for a replayed delivery, with no leaves', () => {
    const page = buildPage();
    const subtree = regionSubtree(page.pageEl, 'ChatPage');
    expect(subtree.root?.element).toBe(page.pageEl);
    expect(subtree.root?.name).toBe('ChatPage');
    expect(subtree.root?.kind).toBe('component');
    expect(subtree.components).toHaveLength(1);
    expect(subtree.leaves).toHaveLength(0);
  });

  it('leaves a single component without a leaf badge of its own', () => {
    const page = buildPage();
    const subtree = flowSubtree([page.pageEl]);
    expect(subtree.components.map((entry) => entry.name)).toEqual(['ChatPage']);
    expect(subtree.leaves).toHaveLength(0);
  });
});
