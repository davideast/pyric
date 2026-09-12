// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom doesn't implement scrollIntoView; the deep-link selection calls it.
g.HTMLElement.prototype.scrollIntoView = () => {};

import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { SandboxEvent } from 'pyric/sandbox';
import { ListenersView } from '../../../src/features/listeners/ListenersView.js';

afterEach(() => cleanup());

/** A controlled input's `change` does not reach React through this JSDOM
 *  harness, so drive the handler the way `shell/remote-clients.test.tsx`
 *  already does. */
function changeInput(input: HTMLElement, value: string) {
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
  act(() => {
    if (propsKey && (input as any)[propsKey]?.onChange) {
      (input as any)[propsKey].onChange({ target: { value } });
    } else {
      fireEvent.change(input, { target: { value } });
    }
  });
}

const CONTEXT = { source: { kind: 'app' as const }, authLens: { mode: 'app-session' as const } };
const WINDOW = { start: 0, end: 60_000 };

function attach(
  id: string,
  listenerId: string,
  at: number,
  owners?: unknown[],
  target: unknown = { kind: 'doc', path: `notes/${listenerId}` },
  source: { kind: string; name?: string } = { kind: 'app' },
): SandboxEvent {
  return {
    kind: 'listener_attach',
    id,
    at,
    listenerId,
    target,
    auth: null,
    operationContext: { ...CONTEXT, source },
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

/** A Firestore delivery carrying the result set the callback received. */
function queryDelivery(
  id: string,
  listenerId: string,
  at: number,
  docs: Array<{ path: string; data: Record<string, unknown> | null }>,
  counts?: { added: number; modified: number; removed: number },
): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'notes' },
    auth: null,
    addedCount: counts?.added ?? docs.length,
    modifiedCount: counts?.modified ?? 0,
    removedCount: counts?.removed ?? 0,
    size: docs.length,
    sample: { docs },
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
  attach('e1', 'l-component', 0, [
    { kind: 'component', name: 'NotesList', path: ['App', 'NotesList'] },
  ]),
  attach('e2', 'l-tag', 1000, [{ kind: 'tag', name: 'sidebar' }]),
  attach('e3', 'l-frame', 2000, [{ kind: 'frame', file: 'app.js', line: 4, function: 'loadNotes' }]),
];

/** The activity monitor raises a duplicate incident from three attaches on
 *  one target; two is not yet a pattern. */
function duplicateAttaches(owners?: unknown[]): SandboxEvent[] {
  const target = { kind: 'doc' as const, path: 'notes/dup' };
  return [
    attach('d1', 'a', 0, owners, target),
    attach('d2', 'b', 10, owners, target),
    attach('d3', 'c', 20, owners, target),
  ];
}

function view(props: Partial<Parameters<typeof ListenersView>[0]> = {}) {
  return render(<ListenersView events={threeListenerEvents} window={WINDOW} {...props} />);
}

function rowIds(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-pyric-listener-row]')].map((row) =>
    row.getAttribute('data-pyric-listener-id'),
  );
}

function cardBox(container: HTMLElement, key: string): HTMLInputElement {
  return container.querySelector(
    `[data-pyric-metric-key="${key}"] [data-pyric-metric-checkbox]`,
  ) as HTMLInputElement;
}

function cells(container: HTMLElement, column: string): (string | null)[] {
  return [...container.querySelectorAll(`[data-pyric-listener-row] [data-col="${column}"]`)].map(
    (cell) => cell.textContent,
  );
}

function openRow(container: HTMLElement, listenerId: string): HTMLElement {
  fireEvent.click(container.querySelector(`[data-pyric-listener-id="${listenerId}"]`)!);
  return container.querySelector('[data-pyric-listener-inspector]') as HTMLElement;
}

describe('the headline and the owner line', () => {
  it('counts the listeners and names nothing else', () => {
    const { container } = view();
    const panel = container.querySelector('[data-pyric-ui="traffic-listeners-view"]')!;
    expect(panel.querySelector('.traffic__metric-eyebrow')!.textContent).toBe('Listener activity');
    expect(panel.querySelector('.traffic__metric-headline')!.textContent).toBe('3 listeners');
    expect(panel.querySelector('[data-pyric-listener-owner-fact]')).toBeNull();
  });

  it('names the duplicate in the headline and the owner holding them', () => {
    const owners = [{ kind: 'component', name: 'ChatPage' }];
    const { container } = view({ events: duplicateAttaches(owners) });
    expect(container.querySelector('.traffic__metric-headline')!.textContent).toBe(
      '3 listeners, 1 attached 3 times',
    );
    expect(container.querySelector('[data-pyric-listener-owner-fact]')!.textContent).toBe(
      'ChatPage · 3 listeners',
    );
  });

  it('says so when nothing is attached, and renders no list', () => {
    const { container } = view({ events: [] });
    expect(container.querySelector('.traffic__metric-headline')!.textContent).toBe(
      'No listeners attached',
    );
    expect(container.querySelector('[data-pyric-listener-grid]')).toBeNull();
  });
});

describe('the metric cards', () => {
  it('counts delivering and idle listeners and filters rows when unchecked', () => {
    const events = [...threeListenerEvents, delivery('v1', 'l-tag', 1500, 'notes/l-tag')];
    const { container } = view({ events });
    const cardValue = (key: string) =>
      container.querySelector(`[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`)!
        .textContent;
    expect(cardValue('delivering')).toBe('1');
    expect(cardValue('idle')).toBe('2');
    expect(rowIds(container)).toHaveLength(3);

    fireEvent.click(cardBox(container, 'idle'));
    expect(rowIds(container)).toEqual(['l-tag']);
  });
});

describe('the grid', () => {
  it('heads five columns in one order and repeats it on every row', () => {
    const { container } = view();
    const header = container.querySelector('[data-pyric-listener-header]')!;
    expect([...header.children].map((cell) => cell.getAttribute('data-col'))).toEqual([
      'incident',
      'target',
      'deliveries',
      'attached',
      'service',
    ]);
    expect([...header.children].map((cell) => cell.textContent)).toEqual([
      '',
      'Target',
      'Deliveries',
      'Attached',
      'Service',
    ]);
    const row = container.querySelector('[data-pyric-listener-row]')!;
    expect([...row.children].map((cell) => cell.getAttribute('data-col'))).toEqual([
      'incident',
      'target',
      'deliveries',
      'attached',
      'service',
    ]);
  });

  it('heads each run of rows with its owner and count, and no owner cell on a row', () => {
    const { container } = view();
    const groups = [...container.querySelectorAll('[data-pyric-listener-group]')];
    expect(groups[0]!.querySelector('[data-col="owner"]')!.textContent).toBe('NotesList');
    expect(groups[0]!.querySelector('[data-col="count"]')!.textContent).toBe('1');
    expect(container.querySelector('[data-pyric-listener-row] [data-col="owner"]')).toBeNull();
  });

  it('groups by component name, tag name, and target, never by a frame', () => {
    const { container } = view();
    const owners = [...container.querySelectorAll('[data-col="owner"]')].map((c) => c.textContent);
    expect(owners).toEqual(['NotesList', 'sidebar', 'notes/l-frame']);
    expect(container.textContent).not.toContain('loadNotes');
    expect(container.textContent).not.toContain('unattributed');
  });

  it('names the service as a word and the attach age in the app’s vocabulary', () => {
    const { container } = view({ now: 12_000 });
    expect(cells(container, 'service')).toEqual(['Firestore', 'Firestore', 'Firestore']);
    expect(cells(container, 'attached')[0]).toBe('12s ago');
  });

  it('collapses same-target listeners into one row carrying ×N', () => {
    const owners = [{ kind: 'tag', name: 'sidebar' }];
    const { container } = view({ events: duplicateAttaches(owners) });
    expect(rowIds(container)).toEqual(['a']);
    expect(container.querySelector('[data-pyric-listener-duplicate]')!.textContent).toBe('×3');
  });

  it('marks a flagged row with the incident mark and nothing else', () => {
    const { container } = view({ events: duplicateAttaches() });
    const row = container.querySelector('[data-pyric-listener-row]')!;
    expect(row.hasAttribute('data-pyric-incident')).toBe(true);
    expect(row.querySelector('[data-col="incident"]')!.textContent).toBe('⚠');
    expect(container.textContent).not.toContain('duplicate ×');
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
    const { container, getByText } = view({ events });
    expect(cells(container, 'target')).toEqual(['busy/one', 'quiet/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(cells(container, 'target')).toEqual(['quiet/one', 'busy/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(cells(container, 'target')).toEqual(['busy/one', 'quiet/one']);
  });

  it('removes a row live when its listener detaches', () => {
    const { container, rerender } = view();
    expect(rowIds(container)).toContain('l-tag');

    rerender(
      <ListenersView
        events={[...threeListenerEvents, detach('e4', 'l-tag', 3000)]}
        window={WINDOW}
      />,
    );

    expect(rowIds(container)).not.toContain('l-tag');
  });

  it('hides listeners Studio itself opened when the toggle is on', () => {
    const events = [
      ...threeListenerEvents,
      attach('e9', 'l-studio', 3000, undefined, { kind: 'doc', path: 'notes/studio' }, {
        kind: 'studio',
      }),
    ];
    expect(rowIds(view({ events }).container)).toContain('l-studio');
    cleanup();
    expect(rowIds(view({ events, hideStudio: true }).container)).not.toContain('l-studio');
  });

  it('says when the filters exclude every listener', () => {
    const { container, getByLabelText } = view();
    changeInput(getByLabelText('Target'), 'nothing/here');
    expect(container.querySelector('[data-pyric-listener-empty]')!.textContent).toBe(
      'No listeners match these filters',
    );
  });
});

describe('the inspector', () => {
  it('opens under the row with the target, its facts, and three numbers', () => {
    const inspector = openRow(view({ now: 24_000 }).container, 'l-tag');
    expect(inspector.querySelector('[data-pyric-inspector-title]')!.textContent).toBe(
      'notes/l-tag',
    );
    expect(inspector.querySelector('[data-pyric-inspector-facts]')!.textContent).toBe(
      'sidebar · Firestore · attached 23s ago',
    );
    const figure = (metric: string) =>
      inspector.querySelector(`[data-pyric-inspector-figure="${metric}"]`)!.textContent;
    expect(figure('deliveries')).toBe('Deliveries0');
    expect(figure('documents')).toBe('Documents0');
    expect(figure('suppressed')).toBe('Suppressed0');
  });

  it('names the element the owners identified in the fact line', () => {
    const events = [
      attach('e1', 'l-el', 0, [
        { kind: 'component', name: 'ChatPage', element: '[data-pyric-owner="nav-1"]' },
        { kind: 'tag', name: 'nav' },
      ]),
    ];
    const inspector = openRow(view({ events, now: 1000 }).container, 'l-el');
    expect(inspector.querySelector('[data-pyric-inspector-facts]')!.textContent).toBe(
      'ChatPage · nav · Firestore · attached 1s ago',
    );
  });

  it('holds no disclosure, and closes on the close control', () => {
    const { container, getByLabelText } = view();
    const inspector = openRow(container, 'l-tag');
    expect(inspector.querySelector('details')).toBeNull();
    expect(inspector.querySelector('[aria-expanded]')).toBeNull();

    fireEvent.click(getByLabelText('Close the listener inspector'));
    expect(container.querySelector('[data-pyric-listener-inspector]')).toBeNull();
  });

  it('opens the listener page from a button', () => {
    const inspector = openRow(view().container, 'l-tag');
    const open = inspector.querySelector('[data-pyric-inspector-open]')!;
    expect(open.tagName).toBe('BUTTON');
    expect(open.textContent).toBe('Open ↗');
  });

  it('states the incident first, with a line per attach', () => {
    const owners = [
      { kind: 'component', name: 'ChatPage', element: '#conversations' },
      { kind: 'tag', name: 'nav' },
      { kind: 'frame', file: 'src/ui/chat/chat-page.tsx', line: 318 },
    ];
    const inspector = openRow(view({ events: duplicateAttaches(owners), now: 20 }).container, 'a');
    const blocks = [...inspector.children];
    expect(blocks[1]!.getAttribute('data-pyric-incident-block')).toBe('');
    expect(blocks[1]!.querySelector('p')!.textContent).toBe(
      '⚠ Attached 3 times by ChatPage · 0s ago, 0s ago and 0s ago',
    );
    const attaches = [...inspector.querySelectorAll('[data-pyric-incident-attach]')];
    expect(attaches).toHaveLength(3);
    expect(attaches[0]!.textContent).toBe('src/ui/chat/chat-page.tsx:318 · nav#conversations');
    expect(attaches[0]!.querySelector('[data-pyric-element]')!.textContent).toBe(
      'nav#conversations',
    );
  });

  it('shows exactly one delivery block: the latest', () => {
    const events = [
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, [{ path: 'notes/one', data: { n: 1 } }]),
      queryDelivery(
        'v2',
        'l-tag',
        1600,
        [
          { path: 'notes/one', data: { n: 1 } },
          { path: 'notes/two', data: { n: 2 } },
        ],
        { added: 1, modified: 0, removed: 0 },
      ),
    ];
    const inspector = openRow(view({ events }).container, 'l-tag');
    const blocks = [...inspector.querySelectorAll('[data-pyric-delivery]')];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.querySelector('[data-pyric-delivery-figures]')!.textContent).toBe(
      '+1 · 2 in snapshot',
    );
    const paths = [...blocks[0]!.querySelectorAll('[data-pyric-delivery-path]')];
    expect(paths.map((line) => line.getAttribute('data-pyric-delivery-path'))).toEqual([
      'notes/two',
    ]);
    expect(paths[0]!.querySelector('[data-pyric-change]')!.textContent).toBe('added');
  });

  it('splits a path into a dimmed prefix and an identifier, linked to the record', () => {
    const events = [
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, [{ path: 'notes/one', data: { n: 1 } }]),
      queryDelivery('v2', 'l-tag', 1600, [{ path: 'notes/one', data: { n: 2 } }]),
    ];
    const inspector = openRow(view({ events }).container, 'l-tag');
    const path = inspector.querySelector('[data-pyric-path="notes/one"]')!;
    expect(path.querySelector('[data-pyric-path-prefix]')!.textContent).toBe('notes/');
    expect(path.querySelector('[data-pyric-path-id]')!.textContent).toBe('one');
    expect(path.closest('a')!.getAttribute('href')).toBe('/firestore/notes/one');
  });

  it('lists no path for the initial delivery', () => {
    const events = [
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, [{ path: 'notes/one', data: { n: 1 } }]),
    ];
    const inspector = openRow(view({ events }).container, 'l-tag');
    expect(inspector.querySelector('[data-pyric-delivery-figures]')!.textContent).toBe(
      'initial · 1 in snapshot',
    );
    expect(inspector.querySelector('[data-pyric-delivery-path]')).toBeNull();
  });

  it('draws the listener’s delivery history when it has one', () => {
    const events = [...threeListenerEvents, delivery('v1', 'l-tag', 1500, 'notes/l-tag')];
    const { container } = view({ events, selectedListenerId: 'l-tag' });
    const row = container.querySelector('[data-pyric-listener-id="l-tag"]')!;
    expect(row.hasAttribute('data-pyric-selected')).toBe(true);
    expect(container.querySelector('[data-pyric-listener-sparkline]')).not.toBeNull();
  });

  it('writes nothing for what was never recorded', () => {
    const { container } = view();
    const inspector = openRow(container, 'l-frame');
    for (const banned of [
      'Not recorded yet',
      'Rendered after each delivery',
      'No deliveries yet',
      'and 3 more',
      'Held by',
      'unattributed',
    ]) {
      expect(inspector.textContent).not.toContain(banned);
    }
  });
});

describe('the footer', () => {
  it('names the source and explains the fold', () => {
    const { container } = view();
    expect(container.querySelector('.traffic__metric-source')!.textContent).toBe(
      'Source: sandbox listener events · listeners attached now, deliveries in this window',
    );
    const methodology = container.querySelector('.traffic__metric-methodology')!;
    expect(methodology.querySelector('summary')!.textContent).toBe('How this is counted');
    expect(methodology.textContent).toContain('detach');
  });
});
