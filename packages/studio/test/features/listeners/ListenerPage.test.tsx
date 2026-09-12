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

function attach(owners?: unknown[], listenerId = 'l-1', at = 12_000): SandboxEvent {
  return {
    kind: 'listener_attach',
    id: `a-${listenerId}-${at}`,
    at,
    listenerId,
    target: { kind: 'query', collection: 'notes' },
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

function suppressed(at: number): SandboxEvent {
  seq += 1;
  return {
    kind: 'snapshot_suppressed',
    id: `x${seq}`,
    at,
    listenerId: 'l-1',
    target: { kind: 'query', collection: 'notes' },
    auth: null,
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
  suppressed(15_000),
];

function page(events: SandboxEvent[] = BASE, listenerId = 'l-1') {
  return render(
    <ListenerPage events={events} listenerId={listenerId} window={WINDOW} now={NOW} />,
  );
}

function cardValue(container: HTMLElement, metric: string): string {
  return container.querySelector(`[data-metric="${metric}"] [data-pyric-metric-value]`)!
    .textContent!;
}

function blocks(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-pyric-delivery]')];
}

describe('the page’s shape', () => {
  it('runs five sections in order, with the back link above them', () => {
    const { container } = page();
    const page_ = container.querySelector('[data-pyric-ui="traffic-listener-page"]')!;
    expect(page_.firstElementChild!.getAttribute('data-pyric-page-back')).toBe('');
    expect(
      [...container.querySelectorAll('[data-pyric-section]')].map((section) =>
        section.getAttribute('data-pyric-section'),
      ),
    ).toEqual(['header', 'cards', 'evidence', 'deliveries', 'documents']);
    expect(container.querySelector('.traffic__metric-eyebrow')!.textContent).toBe('Deliveries');
  });

  it('names the target and its facts, and never the listener id', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-headline')!.textContent).toBe('notes');
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

describe('the cards', () => {
  it('counts deliveries, distinct documents, document reads, and suppressed re-evals', () => {
    const { container } = page();
    expect(cardValue(container, 'deliveries')).toBe('2');
    expect(cardValue(container, 'documents')).toBe('2');
    expect(cardValue(container, 'reads')).toBe('3');
    expect(cardValue(container, 'suppressed')).toBe('1');
    expect(
      [...container.querySelectorAll('[data-pyric-section="cards"] [data-metric]')].map((card) =>
        card.getAttribute('data-metric'),
      ),
    ).toEqual(['deliveries', 'documents', 'reads', 'suppressed']);
  });
});

describe('the evidence chart', () => {
  it('names the span it covers', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-evidence-header h4')!.textContent).toBe(
      'When this listener delivered',
    );
  });

  it('says when nothing landed in the window', () => {
    const { container } = page([attach()]);
    expect(container.querySelector('[data-pyric-section="evidence"]')!.textContent).toContain(
      'No deliveries in this window.',
    );
  });
});

describe('the delivery log', () => {
  it('lists one block per delivery, newest first, and opens nothing', () => {
    const { container } = page();
    const listed = blocks(container);
    expect(listed).toHaveLength(2);
    expect(listed[0]!.querySelector('[data-pyric-delivery-figures]')!.textContent).toBe(
      '+1 ~1 · 2 in snapshot',
    );
    expect(listed[1]!.querySelector('[data-pyric-delivery-figures]')!.textContent).toBe(
      'initial · 1 in snapshot',
    );
    expect(container.querySelector('[data-pyric-delivery-log] details')).toBeNull();
    expect(container.querySelector('[data-pyric-delivery-log] [aria-expanded]')).toBeNull();
  });

  it('lists each changed path with its label, linked to the record', () => {
    const { container } = page();
    const newest = blocks(container)[0]!;
    const paths = [...newest.querySelectorAll('[data-pyric-delivery-path]')];
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
  });

  it('lists no path under the initial delivery', () => {
    const { container } = page();
    expect(blocks(container)[1]!.querySelector('[data-pyric-delivery-path]')).toBeNull();
  });

  it('pages a long history twenty blocks at a time', () => {
    const events: SandboxEvent[] = [attach()];
    for (let index = 0; index < 25; index += 1) {
      events.push(delivery(13_000 + index, [{ path: `notes/n${index}`, data: { n: index } }]));
    }
    const { container } = page(events);
    expect(blocks(container)).toHaveLength(20);
    const more = container.querySelector('[data-pyric-show-more]')!;
    expect(more.textContent).toBe('Show 5 more');
    fireEvent.click(more);
    expect(blocks(container)).toHaveLength(25);
    expect(container.querySelector('[data-pyric-show-more]')).toBeNull();
  });

  it('has no section at all when the listener has never delivered', () => {
    const { container } = page([attach()]);
    expect(container.querySelector('[data-pyric-section="deliveries"]')).toBeNull();
    expect(container.querySelector('[data-pyric-section="documents"]')).toBeNull();
  });
});

describe('the documents', () => {
  it('lists every path with how many deliveries changed it, most changed first', () => {
    const { container } = page();
    const cells = [...container.querySelectorAll('[data-pyric-document-grid] [data-pyric-document]')];
    expect(cells.map((cell) => cell.getAttribute('data-pyric-document'))).toEqual([
      'notes/one',
      'notes/two',
    ]);
    expect(cells.map((cell) => cell.querySelector('[data-pyric-document-changes]')!.textContent)).toEqual([
      '2×',
      '1×',
    ]);
    expect(cells[0]!.querySelector('a')!.getAttribute('href')).toBe('/firestore/notes/one');
  });
});

describe('the incident block', () => {
  it('states the incident under the headline, with a line per attach', () => {
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
    const header = container.querySelector('[data-pyric-section="header"]')!;
    const block = header.querySelector('[data-pyric-incident-block]')!;
    expect(block.querySelector('p')!.textContent).toBe(
      '⚠ Attached 3 times by ChatPage · 12s ago, 12s ago and 12s ago',
    );
    const attaches = [...block.querySelectorAll('[data-pyric-incident-attach]')];
    expect(attaches).toHaveLength(3);
    expect(attaches[0]!.textContent).toBe('src/ui/chat/chat-page.tsx:318 · nav#conversations');
    expect(header.querySelector('[data-pyric-page-facts]')!.textContent).toBe(
      'ChatPage · nav#conversations · Firestore · attached 12s ago',
    );
  });
});

describe('the footer', () => {
  it('names the source and explains the labels', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-source')!.textContent).toContain(
      'Source: sandbox delivery events',
    );
    const methodology = container.querySelector('.traffic__metric-methodology')!;
    expect(methodology.querySelector('summary')!.textContent).toBe('How this is counted');
    expect(methodology.textContent).toContain('added');
    expect(methodology.textContent).toContain('modified');
    expect(methodology.textContent).toContain('removed');
    expect(methodology.textContent).toContain('Document reads');
  });

  it('writes nothing for what was never recorded', () => {
    const { container } = page();
    for (const banned of [
      'Not recorded yet',
      'Rendered after each delivery',
      'Held by',
      'unattributed',
      '2 documents',
      'No deliveries yet',
    ]) {
      expect(container.textContent).not.toContain(banned);
    }
  });
});
