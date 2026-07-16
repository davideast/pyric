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
import {
  TrafficGroupRow,
  TrafficLog,
  useTrafficGroups,
} from '../../../src/traffic/index.js';
import type { TrafficGroup } from '../../../src/traffic/index.js';
import { evt } from '../helpers/fake-source.js';

afterEach(() => cleanup());

const GROUP: TrafficGroup = {
  type: 'group',
  kind: 'listener-run',
  key: 'lr-1',
  events: [
    evt({ id: 'm1', origin: 'listener', result: 'allow' }),
    evt({ id: 'm2', origin: 'listener', result: 'deny' }),
  ],
  count: 2,
  denies: 1,
};

describe('<TrafficGroupRow>', () => {
  it('renders a collapsed header with kind, count, denies', () => {
    const { container } = render(<TrafficGroupRow group={GROUP} />);
    const header = container.querySelector(
      '[data-pyric-traffic-group-header]',
    )!;
    expect(header.getAttribute('data-pyric-group-kind')).toBe('listener-run');
    expect(
      container.querySelector('[data-pyric-group-kind-label]')!.textContent,
    ).toBe('listener re-evals');
    expect(
      container.querySelector('[data-pyric-group-count]')!.textContent,
    ).toBe('×2');
    expect(
      container.querySelector('[data-pyric-group-denies]')!.textContent,
    ).toBe('1 denied');
    // Collapsed by default — no member rows.
    expect(
      container.querySelector('[data-pyric-traffic-group-members]'),
    ).toBeNull();
  });

  it('expands to member rows on header click', () => {
    const { container } = render(<TrafficGroupRow group={GROUP} />);
    fireEvent.click(
      container.querySelector('[data-pyric-traffic-group-header]')!,
    );
    const members = container.querySelectorAll('[data-pyric-traffic-row]');
    expect(members.length).toBe(2);
  });

  it('starts expanded when defaultExpanded is set', () => {
    const { container } = render(
      <TrafficGroupRow group={GROUP} defaultExpanded />,
    );
    expect(
      container.querySelectorAll('[data-pyric-traffic-row]').length,
    ).toBe(2);
  });

  it('fires onSelect from a member row', () => {
    let picked: string | null = null;
    const { container } = render(
      <TrafficGroupRow
        group={GROUP}
        defaultExpanded
        onSelect={(e) => (picked = e.id)}
      />,
    );
    fireEvent.click(
      container.querySelectorAll('[data-pyric-traffic-row]')[1],
    );
    expect(picked).toBe('m2');
  });
});

describe('<TrafficLog> grouped mode', () => {
  function Grouped() {
    const { items } = useTrafficGroups({
      events: [
        evt({ id: 's1' }),
        evt({ id: 'g1', groupId: 'g', origin: 'batch' }),
        evt({ id: 'g2', groupId: 'g', origin: 'batch' }),
      ],
    });
    return <TrafficLog events={[]} items={items} />;
  }

  it('renders singles and group entries from items', () => {
    const { container } = render(<Grouped />);
    const root = container.querySelector('[data-pyric-ui="traffic-log"]')!;
    expect(root.hasAttribute('data-pyric-grouped')).toBe(true);
    expect(
      container.querySelectorAll('[data-pyric-traffic-group-entry]').length,
    ).toBe(1);
    // The single 's1' renders as a normal entry.
    expect(
      container.querySelector('[data-pyric-traffic-id="s1"]'),
    ).not.toBeNull();
  });

  it('renders the empty state for empty items', () => {
    const { container } = render(
      <TrafficLog events={[]} items={[]} emptyState={<span>none</span>} />,
    );
    const root = container.querySelector('[data-pyric-ui="traffic-log"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
  });
});
