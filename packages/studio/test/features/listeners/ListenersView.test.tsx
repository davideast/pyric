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
  target: { kind: 'doc'; path: string } = { kind: 'doc', path: `notes/${listenerId}` },
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
): SandboxEvent {
  return {
    kind: 'snapshot_delivery',
    id,
    at,
    listenerId,
    target: { kind: 'query', collection: 'notes' },
    auth: null,
    addedCount: docs.length,
    modifiedCount: 0,
    removedCount: 0,
    size: docs.length,
    sample: { docs },
    operationContext: CONTEXT,
  } as unknown as SandboxEvent;
}

function docsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-pyric-listener-doc]')].map(
    (link) => link.getAttribute('data-pyric-listener-doc')!,
  );
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

function targets(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-pyric-listener-target]')].map(
    (cell) => cell.textContent,
  );
}

describe('the journal header', () => {
  it('states the count and the absence of incidents', () => {
    const { container } = view();
    const panel = container.querySelector('[data-pyric-ui="traffic-listeners-view"]')!;
    expect(panel.querySelector('.traffic__metric-eyebrow')!.textContent).toBe('Listener activity');
    expect(panel.querySelector('.traffic__metric-headline')!.textContent).toBe(
      '3 listeners attached',
    );
    expect(panel.querySelector('.traffic__metric-finding')!.textContent).toBe(
      'No incidents. 3 listeners have not delivered in this window.',
    );
  });

  it('names a duplicate in the headline and the finding', () => {
    const owners = [{ kind: 'component', name: 'ChatPage' }];
    const { container } = view({ events: duplicateAttaches(owners) });
    expect(container.querySelector('.traffic__metric-headline')!.textContent).toBe(
      '3 listeners, 1 attached more than once',
    );
    expect(container.querySelector('.traffic__metric-finding')!.textContent).toBe(
      'ChatPage holds 3. notes/dup is attached 3 times.',
    );
  });
});

describe('the metric cards', () => {
  it('counts delivering and idle listeners and filters rows when unchecked', () => {
    const events = [
      ...threeListenerEvents,
      delivery('v1', 'l-tag', 1500, 'notes/l-tag'),
    ];
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

  it('keeps a flagged row visible while the incidents card is on', () => {
    const { container } = view({ events: duplicateAttaches() });
    fireEvent.click(cardBox(container, 'idle'));
    expect(rowIds(container)).toEqual(['a']);
  });
});

describe('the evidence chart', () => {
  it('says so when nothing delivered in the window', () => {
    const { container } = view();
    expect(container.textContent).toContain('No deliveries in this window.');
    expect(container.querySelector('.traffic__chart')).toBeNull();
  });

  it('draws a line per service once deliveries land', () => {
    const { container } = view({
      events: [...threeListenerEvents, delivery('v1', 'l-tag', 1500, 'notes/l-tag')],
    });
    expect(container.querySelector('.traffic__chart')).not.toBeNull();
    expect(container.textContent).not.toContain('No deliveries in this window.');
  });
});

describe('the list', () => {
  it('groups by component name, tag name, and target, never by a frame', () => {
    const { container, getAllByText, getByText, queryByText } = view();
    // The owner names the group heading and repeats in the row's owner cell.
    expect(getAllByText('NotesList')).toHaveLength(2);
    expect(getByText('App › NotesList')).toBeDefined();
    expect(getAllByText('sidebar')).toHaveLength(2);
    // The frame-owned listener is filed under its target, not `loadNotes`.
    expect(queryByText('loadNotes')).toBeNull();
    expect(queryByText('unattributed')).toBeNull();
    expect(targets(container)).toContain('notes/l-frame');
  });

  it('heads each group with its owner and count and collapses it on click', () => {
    const { container, getAllByRole } = view();
    const heading = getAllByRole('button', { expanded: true })[0]!;
    expect(heading.textContent).toContain('NotesList');
    expect(heading.textContent).toContain('1');
    fireEvent.click(heading);
    expect(rowIds(container)).toHaveLength(2);
  });

  it('collapses same-target listeners into one row that expands on click', () => {
    const owners = [{ kind: 'tag', name: 'sidebar' }];
    const { container, getByText } = view({ events: duplicateAttaches(owners) });
    expect(getByText('×3')).toBeDefined();
    expect(rowIds(container)).toEqual(['a']);

    fireEvent.click(getByText('×3'));
    expect(rowIds(container)).toEqual(['a', 'a', 'b', 'c']);
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
    expect(targets(container)).toEqual(['busy/one', 'quiet/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(targets(container)).toEqual(['quiet/one', 'busy/one']);

    fireEvent.click(getByText('Deliveries'));
    expect(targets(container)).toEqual(['busy/one', 'quiet/one']);
  });

  it('marks a flagged row and writes the incident as a badge', () => {
    const { container } = view({ events: duplicateAttaches() });
    const row = container.querySelector('[data-pyric-listener-row]')!;
    expect(row.hasAttribute('data-pyric-incident')).toBe(true);
    expect(container.querySelector('.traffic__listener-badge')!.textContent).toBe('duplicate ×3');
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

  it('writes the attach age in the app’s own vocabulary', () => {
    const { container } = view({ now: 12_000 });
    expect(
      container.querySelector('[data-pyric-listener-attached]')!.textContent,
    ).toBe('12s ago');
  });
});

describe('the inspector', () => {
  it('opens beneath the row on a click and closes again', () => {
    const { container, getByLabelText } = view();
    fireEvent.click(container.querySelector('[data-pyric-listener-id="l-tag"]')!);
    const inspector = container.querySelector('[data-pyric-listener-inspector]')!;
    expect(inspector.textContent).toContain('sidebar');
    expect(inspector.textContent).toContain('notes/l-tag');
    expect(inspector.textContent).toContain('Rendered after each delivery');
    expect(inspector.textContent).toContain('Not recorded yet.');

    fireEvent.click(getByLabelText('Close the listener inspector'));
    expect(container.querySelector('[data-pyric-listener-inspector]')).toBeNull();
  });

  it('names the frame a listener was opened at without labelling the row with it', () => {
    const { container } = view();
    fireEvent.click(container.querySelector('[data-pyric-listener-id="l-frame"]')!);
    const inspector = container.querySelector('[data-pyric-listener-inspector]')!;
    expect(inspector.textContent).toContain('Opened at');
    expect(inspector.textContent).toContain('app.js:4');
  });

  it('opens with the deep-linked listener selected, expanded, and drawn', () => {
    const events = [...threeListenerEvents, delivery('v1', 'l-tag', 1500, 'notes/l-tag')];
    const { container } = view({
      events,
      selectedListenerId: 'l-tag',
      initialTargetPrefix: 'notes/l-tag',
    });
    const row = container.querySelector('[data-pyric-listener-id="l-tag"]')!;
    expect(row.hasAttribute('data-pyric-selected')).toBe(true);
    // Only the deep-linked listener's target matches the pre-filled prefix.
    expect(rowIds(container)).toEqual(['l-tag']);
    expect(container.querySelector('[data-pyric-listener-sparkline]')).not.toBeNull();
  });
});

describe("the inspector's Delivered block", () => {
  function openTag(events: SandboxEvent[]) {
    const rendered = view({ events });
    fireEvent.click(rendered.container.querySelector('[data-pyric-listener-id="l-tag"]')!);
    return rendered;
  }

  it('lists the latest delivery as links to the documents, with change badges', () => {
    const { container } = openTag([
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, [{ path: 'notes/one', data: { n: 1 } }]),
      queryDelivery('v2', 'l-tag', 1600, [
        { path: 'notes/one', data: { n: 1 } },
        { path: 'notes/two', data: { n: 2 } },
      ]),
    ]);
    const inspector = container.querySelector('[data-pyric-listener-inspector]') as HTMLElement;
    expect(inspector.textContent).toContain('Delivered');
    expect(docsIn(inspector)).toEqual(['notes/one', 'notes/two']);
    const [unchanged, added] = [...inspector.querySelectorAll('[data-pyric-listener-doc]')];
    expect(unchanged!.getAttribute('data-pyric-listener-change')).toBe('unchanged');
    expect(unchanged!.querySelector('.traffic__listener-change')).toBeNull();
    expect(added!.getAttribute('data-pyric-listener-change')).toBe('added');
    expect(added!.querySelector('.traffic__listener-change')!.textContent).toBe('added');
  });

  it('links a Firestore path to the document route and a database path to rtdb', () => {
    const { container } = openTag([
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, [{ path: 'notes/one', data: { n: 1 } }]),
    ]);
    expect(
      container.querySelector('[data-pyric-listener-doc="notes/one"]')!.getAttribute('href'),
    ).toBe('/firestore/notes/one');
  });

  it('caps the list at six lines and defers the rest to the listener page', () => {
    const docs = Array.from({ length: 9 }, (_unused, index) => ({
      path: `notes/n${index}`,
      data: { n: index },
    }));
    const { container } = openTag([
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, docs),
    ]);
    const inspector = container.querySelector('[data-pyric-listener-inspector]') as HTMLElement;
    expect(docsIn(inspector)).toHaveLength(6);
    const more = inspector.querySelector('[data-pyric-listener-doc-more]')!;
    expect(more.textContent).toBe('and 3 more');
    expect(more.getAttribute('href')).toBe('/traffic/listeners/l-tag');
  });

  it('says the latest delivery listed nothing', () => {
    const { container } = openTag([
      ...threeListenerEvents,
      queryDelivery('v1', 'l-tag', 1500, []),
    ]);
    expect(
      container.querySelector('[data-pyric-listener-delivered-empty]')!.textContent,
    ).toBe('Delivered an empty result.');
  });

  it('says there has been no delivery', () => {
    const { container } = openTag([...threeListenerEvents]);
    expect(
      container.querySelector('[data-pyric-listener-delivered-empty]')!.textContent,
    ).toBe('No deliveries yet.');
  });

  it('links its title to the listener page', () => {
    const { container } = openTag([...threeListenerEvents]);
    expect(container.querySelector('[data-pyric-listener-drill]')!.getAttribute('href')).toBe(
      '/traffic/listeners/l-tag',
    );
  });
});

describe('the empty states', () => {
  it('says nothing is attached', () => {
    const { container } = view({ events: [] });
    expect(container.querySelector('[data-pyric-listener-empty]')!.textContent).toBe(
      'No listeners attached.',
    );
  });

  it('says when the filters exclude every listener', () => {
    const { container, getByPlaceholderText } = view();
    changeInput(getByPlaceholderText('collection or path'), 'nothing/here');
    expect(container.textContent).toContain('No listeners match these filters.');
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
