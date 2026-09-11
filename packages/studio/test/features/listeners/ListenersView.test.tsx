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
// jsdom doesn't implement scrollIntoView; the deep-link selection calls it.
g.HTMLElement.prototype.scrollIntoView = () => {};

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

function delivery(id: string, listenerId: string, at: number, path: string): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at,
    listenerId,
    target: { kind: 'doc', path },
    auth: null,
    operationContext: CONTEXT,
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
  attach('e1', 'l-component', 0, [{ kind: 'component', name: 'NotesList', path: ['App', 'NotesList'] }]),
  attach('e2', 'l-tag', 1000, [{ kind: 'tag', name: 'sidebar' }]),
  attach('e3', 'l-frame', 2000, [{ kind: 'frame', file: 'app.js', line: 4, function: 'loadNotes' }]),
];

describe('ListenersView', () => {
  it('groups by component name, tag name, and target, never by a frame', () => {
    const { getAllByText, getByText, queryByText } = render(
      <ListenersView events={threeListenerEvents} />,
    );
    expect(getByText('NotesList')).toBeDefined();
    expect(getByText('App › NotesList')).toBeDefined();
    expect(getByText('sidebar')).toBeDefined();
    // The frame-owned listener is filed under its target, not `loadNotes`.
    expect(queryByText('loadNotes')).toBeNull();
    expect(queryByText('Unattributed')).toBeNull();
    // Both the group label and the row's target cell name it.
    expect(getAllByText('notes/l-frame').length).toBe(2);
  });

  it('shows the counts header', () => {
    const { getByTestId } = render(<ListenersView events={threeListenerEvents} />);
    expect(getByTestId('listener-counts').textContent).toBe('3 listeners');
  });

  it('counts duplicates and churn in the header', () => {
    const duplicates: SandboxEvent[] = [
      attach('d1', 'a', 0, undefined, { kind: 'doc', path: 'notes/dup' }),
      attach('d2', 'b', 10, undefined, { kind: 'doc', path: 'notes/dup' }),
      attach('d3', 'c', 20, undefined, { kind: 'doc', path: 'notes/dup' }),
    ];
    const { getByTestId } = render(<ListenersView events={duplicates} />);
    expect(getByTestId('listener-counts').textContent).toBe('3 listeners · 1 duplicate');
  });

  it('collapses same-target listeners into one row that expands on click', () => {
    const owners = [{ kind: 'tag', name: 'sidebar' }];
    const duplicates: SandboxEvent[] = [
      attach('d1', 'a', 0, owners, { kind: 'doc', path: 'notes/dup' }),
      attach('d2', 'b', 10, owners, { kind: 'doc', path: 'notes/dup' }),
    ];
    const { getByText, getByTestId, queryByTestId } = render(<ListenersView events={duplicates} />);
    expect(getByText('duplicate ×2')).toBeDefined();
    expect(queryByTestId('listener-duplicate-row-b')).toBeNull();

    fireEvent.click(getByText('duplicate ×2'));
    expect(getByTestId('listener-duplicate-row-a')).toBeDefined();
    expect(getByTestId('listener-duplicate-row-b')).toBeDefined();
  });

  it('removes a row live when its listener detaches', () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ListenersView events={threeListenerEvents} />,
    );
    expect(getByTestId('listener-row-l-tag')).toBeDefined();

    rerender(<ListenersView events={[...threeListenerEvents, detach('e4', 'l-tag', 3000)]} />);

    expect(queryByTestId('listener-row-l-tag')).toBeNull();
  });

  it('runs incidents first, then deliveries descending, and reorders on a header click', () => {
    const owners = [{ kind: 'tag', name: 'sidebar' }];
    const events: SandboxEvent[] = [
      attach('a1', 'quiet', 0, owners, { kind: 'doc', path: 'quiet/one' }),
      attach('a2', 'busy', 10, owners, { kind: 'doc', path: 'busy/one' }),
      delivery('v1', 'busy', 11, 'busy/one'),
      delivery('v2', 'busy', 12, 'busy/one'),
      delivery('v3', 'quiet', 13, 'quiet/one'),
    ];
    const { container, getByText } = render(<ListenersView events={events} />);
    const targets = () =>
      [...container.querySelectorAll('.listeners__cell--target .listeners__mono')].map(
        (cell) => cell.textContent,
      );
    expect(targets()).toEqual(['busy/one', 'quiet/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(targets()).toEqual(['quiet/one', 'busy/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(targets()).toEqual(['busy/one', 'quiet/one']);
  });

  it('opens with the deep-linked listener selected and its detail pane showing', () => {
    const events = [...threeListenerEvents, delivery('v1', 'l-tag', 1500, 'notes/l-tag')];
    const { getByTestId, queryByTestId } = render(
      <ListenersView events={events} selectedListenerId="l-tag" initialTargetPrefix="notes/l-tag" />,
    );
    const row = getByTestId('listener-row-l-tag');
    expect(row.className).toContain('listeners__row--selected');
    // Only the deep-linked listener's target matches the pre-filled prefix.
    expect(queryByTestId('listener-row-l-component')).toBeNull();

    const detail = getByTestId('listener-detail');
    expect(detail.textContent).toContain('sidebar');
    expect(detail.textContent).toContain('notes/l-tag');
    expect(getByTestId('listener-sparkline')).toBeDefined();
    expect(getByTestId('listener-rendered-components').textContent).toContain(
      'Components that rendered after each delivery',
    );
  });

  it('writes times and counts in the app’s own vocabulary', () => {
    const { container } = render(<ListenersView events={threeListenerEvents} now={12_000} />);
    expect(container.textContent).toContain('attached 12s ago');
    expect(container.textContent).toContain('0 deliveries');
    expect(container.textContent).toContain('no deliveries yet');
  });
});
