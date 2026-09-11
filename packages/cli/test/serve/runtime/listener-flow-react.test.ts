/**
 * The whole Flow path against a real React: the commit hook installed before
 * React loads, a delivery reported the way the worker client reports one, a
 * render, and the boxes that come out of the fiber walk.
 *
 * React is not a dependency of this package. It is a dependency of `@pyric/ui`
 * in the same workspace, so the test reaches it there and skips itself when it
 * is not installed. Everything else here is pyric's own code.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { installReactCommitSource } from '../../../src/serve/runtime/react-commit-source.js';
import { startFlowMode } from '../../../src/serve/runtime/listener-flow-mode.js';
import type { ListenerOutline } from '../../../src/serve/runtime/listener-outline-model.js';

const reactDir = fileURLToPath(new URL('../../../../ui/node_modules/react/', import.meta.url));
const reactInstalled = existsSync(reactDir);

const outline: ListenerOutline = {
  listenerId: 'sub-1',
  label: 'ChatPage',
  labelIsOwner: true,
  target: 'conversations/c1/messages',
  isQuery: true,
  service: 'firestore',
  deliveryCount: 1,
  // The element the owner registered, which is what the paint is rooted on.
  selectors: ['#page'],
  incident: null,
};

/**
 * The page globals React reads while its own module first evaluates. Returns
 * the function that puts the process's own globals back, so this file does not
 * leave a JSDOM behind for the rest of the suite.
 */
function installPageGlobals(dom: JSDOM): () => void {
  const view = dom.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const keys = [
    'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event',
    'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'DocumentFragment', 'Text', 'IS_REACT_ACT_ENVIRONMENT',
  ];
  for (const key of keys) {
    saved.set(key, target[key]);
    // React batches its test renders only inside an environment that declares
    // itself one.
    const value = key === 'window'
      ? dom.window
      : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : view[key];
    if (value !== undefined) target[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
  };
}

describe.if(reactInstalled)('the Flow path against a real React', () => {
  it('paints the components that rendered after a delivery', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' });
    const restoreGlobals = installPageGlobals(dom);
    // Installed before React's module is pulled in, which is the whole point
    // of the served page's script order.
    const commits = installReactCommitSource(globalThis);

    const React = await import('../../../../ui/node_modules/react/index.js');
    const client = await import('../../../../ui/node_modules/react-dom/client.js');
    const { createElement: h, useState, act } = React as unknown as {
      createElement: (...args: unknown[]) => unknown;
      useState: <T>(initial: T) => [T, (next: T) => void];
      act: (fn: () => void | Promise<void>) => Promise<void>;
    };

    let publish: ((messages: string[]) => void) | null = null;
    let announce: ((presence: string) => void) | null = null;
    function MessageThread({ messages }: { messages: string[] }): unknown {
      return h('div', { id: 'thread' }, messages.map((text, index) => h('span', { key: index }, text)));
    }
    function Sidebar(): unknown {
      return h('div', { id: 'sidebar' }, 'rooms');
    }
    // The page renders its presence bar as inline JSX, so nothing between the
    // page root and that element is a component of its own.
    function ChatPage(): unknown {
      const [messages, setMessages] = useState<string[]>(['one']);
      const [presence, setPresence] = useState('1 online');
      publish = setMessages;
      announce = setPresence;
      return h(
        'div',
        { id: 'page' },
        h(Sidebar, null),
        h('div', { id: 'presence' }, presence),
        h(MessageThread, { messages }),
      );
    }

    const doc = dom.window.document;
    const root = client.createRoot(doc.querySelector('#root')!);
    await act(() => {
      root.render(h(ChatPage, null));
    });
    expect(commits.available()).toBe(true);

    const container = doc.createElement('div');
    doc.body.append(container);
    let deliver: ((listenerId: string) => void) | null = null;
    const flow = startFlowMode({
      document: doc,
      container,
      commits,
      outlineFor: () => outline,
      isVisible: () => true,
      subscribeDeliveries: (listener) => {
        deliver = listener;
        return () => {};
      },
    });

    // The delivery the worker client would report, then the render it caused.
    deliver!('sub-1');
    await act(() => {
      publish!(['one', 'two']);
      announce!('2 online');
    });

    const marked = [...doc.querySelectorAll<HTMLElement>('[data-pyric-flow]')];
    const labels = marked.map((element) => element.getAttribute('data-pyric-flow-label'));
    // The marks are on the page's own elements, not on measured boxes in the
    // overlay, and the region the owner registered is not one of them.
    expect(container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    expect(doc.querySelector('#page')?.hasAttribute('data-pyric-flow')).toBe(false);
    expect(doc.querySelector('#thread')?.getAttribute('data-pyric-flow-role')).toBe('component');
    // Nothing in the branch that did not re-render is marked.
    expect(doc.querySelector('#sidebar')?.hasAttribute('data-pyric-flow')).toBe(false);
    // The presence bar is inline JSX, so the changed element speaks for itself.
    expect(doc.querySelector('#presence')?.getAttribute('data-pyric-flow-role')).toBe('host');
    // The listener is named once, on the first element the delivery marked.
    expect(labels).toContain('ChatPage · conversations/c1/messages (query) · 1');
    expect(labels.filter((label) => label?.includes(' · ')).length).toBe(1);
    expect(marked.every((element) => (
      element.getAttribute('data-pyric-flow-listener') === 'sub-1'
    ))).toBe(true);

    flow.dispose();
    expect(doc.querySelectorAll('[data-pyric-flow], [data-pyric-flow-label]')).toHaveLength(0);
    commits.dispose();
    restoreGlobals();
  });
});
