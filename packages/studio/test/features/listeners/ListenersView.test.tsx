// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom doesn't implement scrollIntoView; the deep-link highlight calls it.
g.HTMLElement.prototype.scrollIntoView = () => {};

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { SandboxEvent } from 'pyric/sandbox';
import { ListenersView } from '../../../src/features/listeners/ListenersView.js';

afterEach(() => cleanup());

const CONTEXT = { source: { kind: 'app' as const }, authLens: { mode: 'app-session' as const } };

function attach(
  id: string,
  listenerId: string,
  at: number,
  owners?: unknown[],
  target: { kind: 'doc'; path: string } = { kind: 'doc', path: `notes/${listenerId}` },
): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target,
    auth: null,
    operationContext: CONTEXT,
    ...(owners ? { owners } : {}),
  } as unknown as SandboxEvent;
}

function detach(id: string, listenerId: string, at: number): SandboxEvent {
  return {
    kind: 'listener_detach',
    id,
    at,
    listenerId,
    target: { kind: 'doc', path: `notes/${listenerId}` },
    auth: null,
    operationContext: CONTEXT,
  } as unknown as SandboxEvent;
}

const threeListenerEvents: SandboxEvent[] = [
  attach('e1', 'l-component', 0, [{ kind: 'component', name: 'NotesList', path: 'src/NotesList.tsx' }]),
  attach('e2', 'l-tag', 1000, [{ kind: 'tag', name: 'sidebar' }]),
  attach('e3', 'l-frame', 2000, [{ kind: 'frame', file: 'app.js', line: 4 }]),
];

describe('ListenersView', () => {
  it('renders one group per owner, labelled by preference order', () => {
    const { getByText } = render(<ListenersView events={threeListenerEvents} />);
    expect(getByText('NotesList')).toBeDefined();
    expect(getByText('src/NotesList.tsx')).toBeDefined();
    expect(getByText('sidebar')).toBeDefined();
    expect(getByText('app.js')).toBeDefined();
    expect(getByText('3')).toBeDefined(); // total listener count
  });

  it('removes a row live when its listener detaches', () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ListenersView events={threeListenerEvents} />,
    );
    expect(getByTestId('listener-row-l-tag')).toBeDefined();

    const afterDetach = [...threeListenerEvents, detach('e4', 'l-tag', 3000)];
    rerender(<ListenersView events={afterDetach} />);

    expect(queryByTestId('listener-row-l-tag')).toBeNull();
  });

  it('renders a duplicate-listener incident inline on its group', () => {
    const duplicates: SandboxEvent[] = [
      attach('d1', 'a', 0, undefined, { kind: 'doc', path: 'notes/dup' }),
      attach('d2', 'b', 10, undefined, { kind: 'doc', path: 'notes/dup' }),
      attach('d3', 'c', 20, undefined, { kind: 'doc', path: 'notes/dup' }),
    ];
    const { getAllByText } = render(<ListenersView events={duplicates} />);
    expect(getAllByText(/duplicate listener ×3/).length).toBeGreaterThan(0);
  });

  it('opens with the deep-linked listener highlighted and the target filter set', () => {
    const { getByTestId, queryByTestId, getByPlaceholderText } = render(
      <ListenersView
        events={threeListenerEvents}
        highlightListenerId="l-tag"
        initialTargetPrefix="notes/l-tag"
      />,
    );
    const row = getByTestId('listener-row-l-tag');
    expect(row.className).toContain('listeners__row--highlight');
    const filterInput = getByPlaceholderText('collection or path') as HTMLInputElement;
    expect(filterInput.value).toBe('notes/l-tag');
    // Only the deep-linked listener's target matches the pre-filled prefix.
    expect(queryByTestId('listener-row-l-component')).toBeNull();
  });
});
