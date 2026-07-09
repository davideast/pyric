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
import { TrafficLog, TrafficRow } from '../../../src/traffic/index.js';
import { evt } from '../helpers/fake-source.js';

afterEach(() => cleanup());

describe('<TrafficLog>', () => {
  it('renders the empty state when there are no events', () => {
    const { container } = render(
      <TrafficLog events={[]} emptyState={<span>nothing here</span>} />,
    );
    const root = container.querySelector('[data-pyric-ui="traffic-log"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('nothing here');
  });

  it('renders one entry per event with id + structural attrs', () => {
    const events = [
      evt({ id: 'a', method: 'get', result: 'allow', origin: 'user' }),
      evt({ id: 'b', method: 'update', result: 'deny', origin: 'listener' }),
    ];
    const { container } = render(<TrafficLog events={events} />);
    const entries = container.querySelectorAll('[data-pyric-traffic-entry]');
    expect(entries.length).toBe(2);
    expect(entries[0].getAttribute('data-pyric-traffic-id')).toBe('a');

    const rowB = container.querySelector('[data-pyric-traffic-id="b"]')!;
    const btn = rowB.querySelector('[data-pyric-traffic-row]')!;
    expect(btn.getAttribute('data-pyric-result')).toBe('deny');
    expect(btn.getAttribute('data-pyric-origin')).toBe('listener');
    expect(btn.getAttribute('data-pyric-method')).toBe('update');
  });

  it('fires onSelect with the clicked event', () => {
    let picked: string | null = null;
    const events = [evt({ id: 'a' }), evt({ id: 'b' })];
    const { container } = render(
      <TrafficLog events={events} onSelect={(e) => (picked = e.id)} />,
    );
    fireEvent.click(
      container
        .querySelector('[data-pyric-traffic-id="b"]')!
        .querySelector('[data-pyric-traffic-row]')!,
    );
    expect(picked).toBe('b');
  });

  it('marks the selected row with data-pyric-selected', () => {
    const events = [evt({ id: 'a' }), evt({ id: 'b' })];
    const { container } = render(
      <TrafficLog events={events} selectedId="b" />,
    );
    const selected = container.querySelectorAll(
      '[data-pyric-traffic-row][data-pyric-selected]',
    );
    expect(selected.length).toBe(1);
  });

  it('renders the classification slot per row', () => {
    const events = [evt({ id: 'a', result: 'deny' })];
    const { container } = render(
      <TrafficLog
        events={events}
        renderClassification={(e) =>
          e.result === 'deny' ? <span data-test-cls="">flagged</span> : null
        }
      />,
    );
    expect(container.querySelector('[data-test-cls]')).not.toBeNull();
  });

  it('honors the renderRow escape hatch', () => {
    const events = [evt({ id: 'a' })];
    const { container } = render(
      <TrafficLog
        events={events}
        renderRow={(e, selected) => (
          <div data-custom-row="" data-selected={String(selected)}>
            {e.id}
          </div>
        )}
      />,
    );
    const custom = container.querySelector('[data-custom-row]')!;
    expect(custom.textContent).toBe('a');
    expect(container.querySelector('[data-pyric-traffic-row]')).toBeNull();
  });
});

describe('<TrafficRow>', () => {
  it('renders timestamp, method badge, and path — no built-in result chip', () => {
    const event = evt({
      id: 'r',
      method: 'create',
      result: 'allow',
      path: 'events/e1',
      at: 0,
    });
    const { container } = render(
      <TrafficRow event={event} formatTime={() => '12:00:00'} />,
    );
    expect(
      container.querySelector('[data-pyric-traffic-time]')!.textContent,
    ).toBe('12:00:00');
    expect(
      container.querySelector('[data-pyric-traffic-path]')!.textContent,
    ).toBe('events/e1');
    expect(
      container.querySelector('[data-pyric-badge-kind="create"]'),
    ).not.toBeNull();
    // The result lives on the row attr only; any visible outcome label is
    // the consumer's `renderClassification` slot (one pill, not two chips).
    expect(container.querySelector('[data-pyric-badge-kind="allow"]')).toBeNull();
    expect(
      container
        .querySelector('[data-pyric-traffic-row]')!
        .getAttribute('data-pyric-result'),
    ).toBe('allow');
  });
});
