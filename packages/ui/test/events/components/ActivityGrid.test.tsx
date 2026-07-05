// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ActivityGrid } from '../../../src/events/components/ActivityGrid.js';
import { ActivityActionItems } from '../../../src/events/components/ActivityActionItems.js';
import { computeActivityDigest } from '../../../src/events/digest.js';
import { reqEvent, writeEvent, svcEvent } from '../helpers/fake-events.js';

const NOW = 1_700_000_100_000;

afterEach(() => cleanup());

describe('<ActivityGrid>', () => {
  it('renders the empty state when there are no rows', () => {
    const { container } = render(
      <ActivityGrid events={[]} emptyState={<span>nothing</span>} />,
    );
    const root = container.querySelector('[data-pyric-ui="activity-grid"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toContain('nothing');
  });

  it('renders band headers with key, count, and attribution', () => {
    const events = [
      reqEvent({ result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
      reqEvent({ result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
      writeEvent({ method: 'create' }),
    ];
    const { container } = render(<ActivityGrid events={events} options={{ now: NOW }} />);

    const deniedBand = container.querySelector(
      '[data-pyric-band][data-pyric-band-key="denied"]',
    )!;
    expect(deniedBand).not.toBeNull();
    expect(deniedBand.hasAttribute('data-pyric-band-denied')).toBe(true);
    expect(deniedBand.getAttribute('data-pyric-band-count')).toBe('2');
    expect(
      deniedBand.querySelector('[data-pyric-band-label]')!.textContent,
    ).toBe('Denied');
    expect(
      deniedBand.querySelector('[data-pyric-band-attr]')!.textContent,
    ).toBe('all by alice');
  });

  it('renders the denied band first (lead-with-consequence)', () => {
    const events = [
      writeEvent({ method: 'create' }),
      reqEvent({ result: 'deny', reasons: ['Rule #0 (create) → DENY'] }),
    ];
    const { container } = render(<ActivityGrid events={events} options={{ now: NOW }} />);
    const bands = [...container.querySelectorAll('[data-pyric-band]')];
    expect(bands[0].getAttribute('data-pyric-band-key')).toBe('denied');
  });

  it('renders each row with the five columns and provenance attributes', () => {
    const events = [
      writeEvent({
        method: 'create',
        path: 'notes/n9',
        auth: { uid: 'bob' },
        authLens: { mode: 'admin' },
        nextState: { title: 'Hi' },
      }),
    ];
    const { container } = render(<ActivityGrid events={events} options={{ now: NOW }} />);
    const row = container.querySelector('[data-pyric-event-row]')!;
    expect(row.getAttribute('data-pyric-event-band')).toBe('added');
    expect(row.getAttribute('data-pyric-event-lens')).toBe('admin');
    expect(row.querySelector('[data-pyric-event-target]')!.textContent).toBe('notes/n9');
    expect(row.querySelector('[data-pyric-event-change]')!.textContent).toBe('"Hi"');
    expect(row.querySelector('[data-pyric-event-for]')!.textContent).toBe('bob');
    expect(row.querySelector('[data-pyric-event-lens]')!.textContent).toBe('admin');
  });

  it('flags denied rows with data-pyric-event-denied', () => {
    const events = [reqEvent({ result: 'deny', reasons: ['Rule #0 (update) → DENY'] })];
    const { container } = render(<ActivityGrid events={events} options={{ now: NOW }} />);
    const row = container.querySelector('[data-pyric-event-row]')!;
    expect(row.hasAttribute('data-pyric-event-denied')).toBe(true);
  });

  it('renders the column header row by default', () => {
    const events = [writeEvent({ method: 'create' })];
    const { container } = render(<ActivityGrid events={events} options={{ now: NOW }} />);
    const cols = [...container.querySelectorAll('[data-pyric-event-col]')].map(
      (c) => c.getAttribute('data-pyric-event-col'),
    );
    expect(cols).toEqual(['target', 'change', 'for', 'as', 'when']);
  });

  it('clamps rows per band and renders a "N more" stub with the true count', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      writeEvent({ id: `c${i}`, method: 'create' }),
    );
    const { container } = render(
      <ActivityGrid events={events} options={{ now: NOW }} maxRowsPerBand={2} />,
    );
    expect(container.querySelectorAll('[data-pyric-event-row]').length).toBe(2);
    const more = container.querySelector('[data-pyric-band-more]')!;
    expect(more.textContent).toBe('3 more added');
  });

  it('fires onSelect with the row', () => {
    const events = [writeEvent({ id: 'r1', method: 'create' })];
    let picked: string | undefined;
    const { container } = render(
      <ActivityGrid
        events={events}
        options={{ now: NOW }}
        onSelect={(r) => (picked = r.id)}
      />,
    );
    fireEvent.click(container.querySelector('[data-pyric-event-row]')!);
    expect(picked).toBe('r1');
  });

  it('renders pivot subgroups when grouped', () => {
    const events = [
      writeEvent({ method: 'create', actor: { kind: 'app' } }),
      writeEvent({ method: 'create', actor: { kind: 'agent', name: 'atlas' } }),
    ];
    const { container } = render(
      <ActivityGrid events={events} options={{ now: NOW, groupBy: 'actor' }} />,
    );
    const groups = container.querySelectorAll('[data-pyric-band-subgroup]');
    expect(groups.length).toBe(2);
  });

  it('accepts a precomputed digest', () => {
    const digest = computeActivityDigest(
      [svcEvent({ service: 'auth', op: 'sign_in', path: 'alice' })],
      { now: NOW },
    );
    const { container } = render(<ActivityGrid digest={digest} />);
    expect(
      container.querySelector('[data-pyric-band-key="signed-in"]'),
    ).not.toBeNull();
  });
});

describe('<ActivityActionItems>', () => {
  it('renders nothing when there are no denials', () => {
    const digest = computeActivityDigest([writeEvent({ method: 'create' })], {
      now: NOW,
    });
    const { container } = render(<ActivityActionItems digest={digest} />);
    expect(
      container.querySelector('[data-pyric-ui="activity-action-items"]'),
    ).toBeNull();
  });

  it('aggregates denials by collection prefix with mechanical copy', () => {
    const digest = computeActivityDigest(
      [
        reqEvent({ path: 'notes/a', result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
        reqEvent({ path: 'notes/b', result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
      ],
      { now: NOW },
    );
    const { container } = render(<ActivityActionItems digest={digest} />);
    const item = container.querySelector('[data-pyric-action-item]')!;
    expect(item.getAttribute('data-pyric-action-type')).toBe('denied');
    expect(item.getAttribute('data-pyric-action-count')).toBe('2');
    expect(
      item.querySelector('[data-pyric-action-title]')!.textContent,
    ).toBe('2 writes to /notes were denied');
    expect(
      item.querySelector('[data-pyric-action-meta]')!.textContent,
    ).toBe('All by alice.');
  });

  it('renders the host action affordance', () => {
    const digest = computeActivityDigest(
      [reqEvent({ path: 'notes/a', result: 'deny', reasons: ['Rule #0 (update) → DENY'] })],
      { now: NOW },
    );
    const { container } = render(
      <ActivityActionItems
        digest={digest}
        renderAction={() => <button type="button">Debug</button>}
      />,
    );
    const affordance = container.querySelector('[data-pyric-action-affordance]')!;
    expect(affordance.textContent).toBe('Debug');
  });
});
