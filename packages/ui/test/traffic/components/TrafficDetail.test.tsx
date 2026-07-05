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
import { TrafficDetail } from '../../../src/traffic/index.js';
import { evt } from '../helpers/fake-source.js';

afterEach(() => cleanup());

function sectionLabels(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('[data-pyric-traffic-section]'),
  ).map((s) => s.getAttribute('data-pyric-section-label')!);
}

describe('<TrafficDetail>', () => {
  it('always renders the AUTH section; omits write-only sections for reads', () => {
    const event = evt({ method: 'get', result: 'allow' });
    const { container } = render(<TrafficDetail event={event} />);
    const labels = sectionLabels(container);
    expect(labels).toContain('AUTH');
    expect(labels).not.toContain('REQUEST · resource.data');
    expect(labels).not.toContain('RESOURCE AFTER');
  });

  it('renders request + resource sections for a write', () => {
    const event = evt({
      method: 'update',
      result: 'deny',
      request: { resourceData: { name: 'Final' } },
      resourceBefore: { data: { name: 'Old' }, exists: true },
      resourceAfter: { data: { name: 'Final' }, exists: true },
    });
    const { container } = render(<TrafficDetail event={event} />);
    const labels = sectionLabels(container);
    expect(labels).toContain('REQUEST · resource.data');
    expect(labels).toContain('RESOURCE BEFORE');
    expect(labels).toContain('RESOURCE AFTER');
  });

  it('renders reasons with a per-line verdict', () => {
    const event = evt({
      reasons: ['Rule #0 (read) → ALLOW', 'Rule #2 (update) → deny'],
    });
    const { container } = render(<TrafficDetail event={event} />);
    const reasons = container.querySelectorAll('[data-pyric-traffic-reason]');
    expect(reasons.length).toBe(2);
    expect(reasons[0].getAttribute('data-pyric-reason-verdict')).toBe('allow');
    expect(reasons[1].getAttribute('data-pyric-reason-verdict')).toBe('deny');
  });

  it('renders the matched rule line when present', () => {
    const event = evt({
      matchedRule: { ruleIndex: 2, operations: ['update'] },
    });
    const { container } = render(<TrafficDetail event={event} />);
    expect(
      container.querySelector('[data-pyric-traffic-matched-rule]')!.textContent,
    ).toContain('#2');
  });

  it('renders triggeredBy and groupId sections when present', () => {
    const event = evt({
      origin: 'listener',
      groupId: 'batch-1',
      triggeredBy: { method: 'create', path: 'events/e1' },
    });
    const { container } = render(<TrafficDetail event={event} />);
    const labels = sectionLabels(container);
    expect(labels).toContain('TRIGGERED BY');
    expect(labels).toContain('GROUP');
    expect(
      container.querySelector('[data-pyric-traffic-group]')!.textContent,
    ).toBe('batch-1');
  });

  it('fires onBack from the back affordance', () => {
    let backed = false;
    const { container } = render(
      <TrafficDetail event={evt()} onBack={() => (backed = true)} />,
    );
    fireEvent.click(container.querySelector('[data-pyric-traffic-back]')!);
    expect(backed).toBe(true);
  });

  it('renders the classification slot below the header', () => {
    const { container } = render(
      <TrafficDetail
        event={evt({ result: 'deny' })}
        renderClassification={() => <div data-test-overlay="">analysis</div>}
      />,
    );
    expect(container.querySelector('[data-test-overlay]')).not.toBeNull();
  });
});
