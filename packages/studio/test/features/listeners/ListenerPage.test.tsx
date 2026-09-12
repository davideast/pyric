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

function attach(owners?: unknown[]): SandboxEvent {
  return {
    kind: 'listener_attach',
    id: 'a1',
    at: 12_000,
    listenerId: 'l-1',
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
): SandboxEvent {
  seq += 1;
  return {
    kind: 'snapshot_delivery',
    id: `v${seq}`,
    at,
    listenerId: 'l-1',
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
  delivery(14_000, [
    { path: 'notes/one', data: { n: 2 } },
    { path: 'notes/two', data: { n: 2 } },
  ]),
  suppressed(15_000),
];

function page(events: SandboxEvent[] = BASE, listenerId = 'l-1') {
  return render(
    <ListenerPage events={events} listenerId={listenerId} window={WINDOW} now={NOW} />,
  );
}

function cardValue(container: HTMLElement, key: string): string {
  return container.querySelector(
    `[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`,
  )!.textContent!;
}

function rows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-pyric-listener-delivery-row]')];
}

describe('the header', () => {
  it('names the target, who holds it, how long it has been attached, and the service', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-eyebrow')!.textContent).toBe('Listener');
    expect(container.querySelector('.traffic__metric-headline')!.textContent).toBe('notes');
    expect(container.querySelector('.traffic__metric-finding')!.textContent).toBe(
      'Held by NotesList · attached 12s ago · Firestore',
    );
  });

  it('never puts the listener id on the page', () => {
    const { container } = page();
    expect(container.textContent).not.toContain('l-1');
  });
});

describe('the cards', () => {
  it('counts deliveries, distinct documents, and suppressed re-evals', () => {
    const { container } = page();
    expect(cardValue(container, 'deliveries')).toBe('2');
    expect(cardValue(container, 'documents')).toBe('2');
    expect(cardValue(container, 'suppressed')).toBe('1');
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
    expect(container.querySelector('.traffic__metric-evidence')!.textContent).toContain(
      'No deliveries in this window.',
    );
  });
});

describe('the delivery log', () => {
  it('lists one row per delivery, newest first, with counts and a document count', () => {
    const { container } = page();
    const listed = rows(container);
    expect(listed).toHaveLength(2);
    expect(
      listed[0]!.querySelector('[data-pyric-listener-delivery-counts]')!.textContent,
    ).toBe('+2 ~0 -0');
    expect(listed[0]!.querySelector('[data-pyric-listener-delivery-size]')!.textContent).toBe(
      '2 documents',
    );
    expect(listed[1]!.querySelector('[data-pyric-listener-delivery-size]')!.textContent).toBe(
      '1 document',
    );
  });

  it('expands a row into its document paths, with the render slot', () => {
    const { container } = page();
    fireEvent.click(rows(container)[0]!);
    const detail = container.querySelector('.traffic__listener-delivery-detail') as HTMLElement;
    expect(
      [...detail.querySelectorAll('[data-pyric-listener-doc]')].map((link) =>
        link.getAttribute('data-pyric-listener-doc'),
      ),
    ).toEqual(['notes/one', 'notes/two']);
    expect(
      detail.querySelector('[data-pyric-listener-doc="notes/one"]')!.getAttribute('href'),
    ).toBe('/firestore/notes/one');
    expect(detail.textContent).toContain('Rendered after each delivery');
    expect(detail.querySelector('[data-pyric-listener-rendered]')!.textContent).toBe(
      'Not recorded yet.',
    );
  });

  it('pages a long history twenty rows at a time', () => {
    const events: SandboxEvent[] = [attach()];
    for (let index = 0; index < 25; index += 1) {
      events.push(delivery(13_000 + index, [{ path: `notes/n${index}`, data: { n: index } }]));
    }
    const { container } = page(events);
    expect(rows(container)).toHaveLength(20);
    const more = container.querySelector('[data-pyric-listener-show-more]')!;
    expect(more.textContent).toBe('Show 5 more');
    fireEvent.click(more);
    expect(rows(container)).toHaveLength(25);
    expect(container.querySelector('[data-pyric-listener-show-more]')).toBeNull();
  });

  it('says when a listener has never delivered', () => {
    const { container } = page([attach()]);
    expect(container.querySelector('[data-pyric-listener-empty]')!.textContent).toBe(
      'No deliveries yet.',
    );
  });
});

describe('the back link', () => {
  it('returns to the Listeners tab', () => {
    const { container } = page();
    const back = container.querySelector('[data-pyric-listener-back]')!;
    expect(back.textContent).toBe('Listeners');
    expect(back.getAttribute('href')).toBe('/traffic?view=listeners');
  });

  it('is there even when the listener is no longer attached', () => {
    const { container } = page(BASE, 'gone');
    expect(container.querySelector('[data-pyric-listener-back]')).not.toBeNull();
    expect(container.querySelector('[data-pyric-listener-missing]')!.textContent).toBe(
      'This listener is not attached in this session.',
    );
  });
});

describe('the footer', () => {
  it('names the source and explains the diff', () => {
    const { container } = page();
    expect(container.querySelector('.traffic__metric-source')!.textContent).toContain(
      'Source: sandbox delivery events',
    );
    const methodology = container.querySelector('.traffic__metric-methodology')!;
    expect(methodology.querySelector('summary')!.textContent).toBe('How this is counted');
    expect(methodology.textContent).toContain('added');
    expect(methodology.textContent).toContain('modified');
    expect(methodology.textContent).toContain('removed');
  });
});
