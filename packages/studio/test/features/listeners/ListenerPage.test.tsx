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

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { SandboxEvent } from 'pyric/sandbox';
import { ListenerPage } from '../../../src/features/listeners/ListenerPage.js';

afterEach(() => cleanup());

const CONTEXT = { source: { kind: 'app' as const }, authLens: { mode: 'app-session' as const } };
const WINDOW = { start: 0, end: 60_000 };
const NOW = 24_000;

/** The query a `where` + `orderBy` + `limit` listen records on its attach. */
const NOTES_QUERY = {
  scope: { kind: 'collection' },
  filters: [{
    kind: 'where',
    field: 'owner',
    op: '==',
    display: { type: 'string', value: 'u_8f2a' },
  }],
  orderBy: [{ field: 'updatedAt', direction: 'desc' }],
  limit: 50,
  limitFromEnd: false,
  start: null,
  end: null,
};

function attach(
  owners?: unknown[],
  listenerId = 'l-1',
  at = 12_000,
  query: unknown = NOTES_QUERY,
): SandboxEvent {
  return {
    kind: 'listener_attach',
    id: `a-${listenerId}-${at}`,
    at,
    listenerId,
    target: { kind: 'query', collection: 'notes', ...(query === null ? {} : { query }) },
    auth: null,
    operationContext: CONTEXT,
    ...(owners ? { owners } : {}),
  } as unknown as SandboxEvent;
}

let seq = 0;

function delivery(
  at: number,
  docs: Array<{ path: string; data: Record<string, unknown> | null }>,
  counts?: { added: number; modified: number; removed: number },
): SandboxEvent {
  seq += 1;
  return {
    kind: 'snapshot_delivery',
    id: `v${seq}`,
    at,
    listenerId: 'l-1',
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

const BASE: SandboxEvent[] = [
  attach([{ kind: 'component', name: 'NotesList', path: ['App', 'NotesList'] }]),
  delivery(13_000, [{ path: 'notes/one', data: { n: 1 } }]),
  delivery(
    14_000,
    [
      { path: 'notes/one', data: { n: 2 } },
      { path: 'notes/two', data: { n: 2 } },
    ],
    { added: 1, modified: 1, removed: 0 },
  ),
];

function page(events: SandboxEvent[] = BASE, listenerId = 'l-1') {
  return render(
    <ListenerPage events={events} listenerId={listenerId} window={WINDOW} now={NOW} />,
  );
}

function cardValue(container: HTMLElement, key: string): string {
  return container
    .querySelector(`[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`)!
    .textContent!;
}

function rows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-pyric-delivery-entry]')];
}

function figures(row: Element): string[] {
  return [
    row.querySelector('[data-pyric-delivery-time]')!.textContent!,
    row.querySelector('[data-pyric-delivery-figures]')!.textContent!,
    row.querySelector('[data-pyric-delivery-snapshot]')!.textContent!,
  ];
}

describe('the page’s shape', () => {
  it('runs the header, the cards, and the deliveries, with the back link above them', () => {
    const { container } = page();
    const surface = container.querySelector('[data-pyric-ui="traffic-listener-page"]')!;
    expect(surface.firstElementChild!.getAttribute('data-pyric-page-back')).toBe('');
    expect(
      [...container.querySelectorAll('[data-pyric-section]')].map((section) =>
        section.getAttribute('data-pyric-section'),
      ),
    ).toEqual(['header', 'cards', 'deliveries']);
  });

  it('names the target and its facts, and never the listener id', () => {
    const { container } = page();
    expect(container.querySelector('[data-pyric-page-title]')!.textContent).toBe('notes (query)');
    expect(container.querySelector('[data-pyric-page-facts]')!.textContent).toBe(
      'NotesList · Firestore · attached 12s ago',
    );
    expect(container.textContent).not.toContain('l-1');
  });

  it('returns to the Listeners tab', () => {
    const { container } = page();
    const back = container.querySelector('[data-pyric-page-back]')!;
    expect(back.textContent).toBe('← Listeners');
    expect(back.getAttribute('href')).toBe('/traffic?view=listeners');
  });

  it('is the back link alone when the listener is no longer attached', () => {
    const { container } = page(BASE, 'gone');
    expect(container.querySelector('[data-pyric-page-back]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-listener-missing]')!.textContent).toBe(
      'This listener is not attached in this session.',
    );
  });
});

describe('the query block', () => {
  it('prints the call the app wrote, one constraint per line', () => {
    const { container } = page();
    expect(container.querySelector('[data-pyric-query-text]')!.textContent).toBe([
      "query(collection(db, 'notes'),",
      "  where('owner', '==', 'u_8f2a'),",
      "  orderBy('updatedAt', 'desc'),",
      '  limit(50))',
    ].join('\n'));
  });

  it('hands the whole call to the copy control', () => {
    const { container } = page();
    const copy = container.querySelector('[data-pyric-query-copy]')!;
    expect(copy.getAttribute('data-pyric-copy-value')).toContain("where('owner', '==', 'u_8f2a')");
  });

  it('prints the collection alone when the listen carried no constraints', () => {
    const { container } = page([attach(undefined, 'l-1', 12_000, null), ...BASE.slice(1)]);
    expect(container.querySelector('[data-pyric-query-text]')!.textContent).toBe(
      "collection(db, 'notes')",
    );
  });
});

describe('the cards', () => {
  it('counts deliveries, the snapshot in documents, and the estimated reads', () => {
    const { container } = page();
    expect(cardValue(container, 'deliveries')).toBe('2');
    expect(cardValue(container, 'snapshot')).toBe('2 documents');
    expect(cardValue(container, 'reads')).toBe('3');
    expect(
      [...container.querySelectorAll('[data-pyric-section="cards"] [data-pyric-metric-key]')].map(
        (card) => card.getAttribute('data-pyric-metric-key'),
      ),
    ).toEqual(['deliveries', 'snapshot', 'reads']);
  });

  it('states what the read estimate covers', () => {
    const { container } = page();
    expect(container.querySelector('[data-pyric-metric-footnote]')!.textContent).toBe(
      'Estimated reads: initial snapshot + documents added or modified since'
      + ' · reconnects and duplicate listeners not counted',
    );
  });
});

describe('the delivery rows', () => {
  it('lists one row per delivery, newest first, with its figures and snapshot', () => {
    const { container } = page();
    const listed = rows(container);
    expect(listed).toHaveLength(2);
    expect(figures(listed[0]!)).toEqual(['12:00:14 AM', '+1 ~1', '2 in snapshot']);
    expect(figures(listed[1]!)).toEqual(['12:00:13 AM', 'initial', '1 in snapshot']);
  });

  it('opens the paths one row changed, and closes them when another opens', () => {
    const { container } = page();
    fireEvent.click(rows(container)[0]!.querySelector('[data-pyric-delivery-row]')!);
    const changes = container.querySelector('[data-pyric-delivery-changes]')!;
    const paths = [...changes.querySelectorAll('[data-pyric-delivery-path]')];
    expect(paths.map((line) => line.getAttribute('data-pyric-delivery-path'))).toEqual([
      'notes/one',
      'notes/two',
    ]);
    expect(paths.map((line) => line.querySelector('[data-pyric-change]')!.textContent)).toEqual([
      'modified',
      'added',
    ]);
    expect(paths[0]!.querySelector('a')!.getAttribute('href')).toBe('/firestore/notes/one');
    expect(paths[0]!.querySelector('[data-pyric-path-prefix]')!.textContent).toBe('notes/');
    expect(paths[0]!.querySelector('[data-pyric-path-id]')!.textContent).toBe('one');

    fireEvent.click(rows(container)[0]!.querySelector('[data-pyric-delivery-row]')!);
    expect(container.querySelector('[data-pyric-delivery-changes]')).toBeNull();
  });

  it('opens nothing under the initial delivery', () => {
    const { container } = page();
    const initial = rows(container)[1]!.querySelector('[data-pyric-delivery-row]')!;
    expect(initial.hasAttribute('disabled')).toBe(true);
    fireEvent.click(initial);
    expect(container.querySelector('[data-pyric-delivery-changes]')).toBeNull();
  });

  it('has no deliveries section at all when the listener has never delivered', () => {
    const { container } = page([attach()]);
    expect(container.querySelector('[data-pyric-section="deliveries"]')).toBeNull();
  });
});

describe('the timeline', () => {
  it('states nothing about an interval until one is brushed', () => {
    const { container } = page();
    expect(container.querySelector('[data-pyric-interval]')).toBeNull();
  });

  it('narrows the rows to the brushed interval and states its figures', () => {
    const { container } = page();
    // 36 buckets over a minute: the 14s delivery sits alone in the ninth.
    const buckets = [...container.querySelectorAll('[data-pyric-bucket]')];
    fireEvent.click(buckets[8]!);
    expect(rows(container)).toHaveLength(1);
    expect(figures(rows(container)[0]!)[0]).toBe('12:00:14 AM');
    expect(container.querySelector('[data-pyric-interval-facts]')!.textContent).toBe(
      '12:00:13–12:00:15 · 1 delivery · 1 added · 1 modified',
    );
  });

  it('shows every delivery again when the brushed bar is clicked a second time', () => {
    const { container } = page();
    const buckets = [...container.querySelectorAll('[data-pyric-bucket]')];
    fireEvent.click(buckets[8]!);
    fireEvent.click(buckets[8]!);
    expect(rows(container)).toHaveLength(2);
    expect(container.querySelector('[data-pyric-interval]')).toBeNull();
  });
});

describe('the incident block', () => {
  it('states the incident over the totals, with a line per attach', () => {
    const owners = [
      { kind: 'component', name: 'ChatPage', element: '#conversations' },
      { kind: 'tag', name: 'nav' },
      { kind: 'frame', file: 'src/ui/chat/chat-page.tsx', line: 318 },
    ];
    const events = [
      attach(owners, 'l-1', 12_000),
      attach(owners, 'l-2', 12_100),
      attach(owners, 'l-3', 12_200),
    ];
    const { container } = page(events);
    const block = container.querySelector('[data-pyric-incident-block]')!;
    expect(block.querySelector('p')!.textContent).toBe(
      '⚠ Attached 3 times by ChatPage · 12s ago, 12s ago and 12s ago',
    );
    const attaches = [...block.querySelectorAll('[data-pyric-incident-attach]')];
    expect(attaches).toHaveLength(3);
    expect(attaches[0]!.textContent).toBe('src/ui/chat/chat-page.tsx:318 · nav#conversations');
    expect(container.querySelector('[data-pyric-page-facts]')!.textContent).toBe(
      'ChatPage · nav#conversations · Firestore · attached 12s ago',
    );
  });
});

describe('what the page does not say', () => {
  it('names the source and explains the labels in the footer', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-footer .traffic__metric-source')!.textContent)
      .toContain('Source: sandbox delivery events');
    const methodology = container.querySelector('.traffic__metric-methodology')!;
    expect(methodology.querySelector('summary')!.textContent).toBe('How this is counted');
    expect(methodology.textContent).toContain('added');
    expect(methodology.textContent).toContain('modified');
    expect(methodology.textContent).toContain('removed');
  });

  it('writes nothing for what the page no longer states', () => {
    const { container } = page();
    for (const banned of [
      'Not recorded yet',
      'Rendered after each delivery',
      'Held by',
      'unattributed',
      'Suppressed',
      'Document reads',
      'Show 20 more',
      'Open',
    ]) {
      expect(container.textContent).not.toContain(banned);
    }
  });
});
