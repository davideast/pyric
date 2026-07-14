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
import { TrafficTimeline } from '../../../src/traffic/index.js';
import type { TimeWindow } from '../../../src/traffic/index.js';
import { evt } from '../helpers/fake-source.js';

afterEach(() => cleanup());

const WINDOW: TimeWindow = { start: 0, end: 1000 };

describe('<TrafficTimeline>', () => {
  it('renders the empty state when the window has no width', () => {
    const { container } = render(
      <TrafficTimeline
        events={[]}
        window={{ start: 0, end: 0 }}
        emptyState={<span>no traffic</span>}
      />,
    );
    const root = container.querySelector('[data-pyric-ui="traffic-timeline"]')!;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.textContent).toBe('no traffic');
  });

  it('renders one bar per bucket with count + deny attrs', () => {
    const events = [
      evt({ at: 150, result: 'allow' }),
      evt({ at: 160, result: 'deny' }),
      evt({ at: 950, result: 'allow' }),
    ];
    const { container } = render(
      <TrafficTimeline events={events} window={WINDOW} bucketCount={10} />,
    );
    const bars = container.querySelectorAll('[data-pyric-bucket]');
    expect(bars.length).toBe(10);
    expect(bars[1].getAttribute('data-pyric-bucket-count')).toBe('2');
    expect(bars[1].getAttribute('data-pyric-bucket-denies')).toBe('1');
    expect(bars[1].hasAttribute('data-pyric-has-denies')).toBe(true);
    expect(bars[0].hasAttribute('data-pyric-has-denies')).toBe(false);
  });

  it('exposes bar + deny heights as CSS custom properties', () => {
    const events = [
      evt({ at: 150 }),
      evt({ at: 150 }),
      evt({ at: 950, result: 'deny' }),
    ];
    const { container } = render(
      <TrafficTimeline events={events} window={WINDOW} bucketCount={10} />,
    );
    const bars = container.querySelectorAll('[data-pyric-bucket]');
    expect((bars[1] as HTMLElement).style.getPropertyValue('--pyric-bucket-h')).toBe('1');
    expect((bars[9] as HTMLElement).style.getPropertyValue('--pyric-bucket-h')).toBe('0.5');
    expect(
      (bars[9] as HTMLElement).style.getPropertyValue('--pyric-bucket-deny-h'),
    ).toBe('0.5');
  });

  it('renders separate allow + deny segments per bar', () => {
    const { container } = render(
      <TrafficTimeline events={[evt({ at: 150 })]} window={WINDOW} bucketCount={10} />,
    );
    const bar = container.querySelectorAll('[data-pyric-bucket]')[1];
    expect(bar.querySelector('[data-pyric-bucket-allow]')).not.toBeNull();
    expect(bar.querySelector('[data-pyric-bucket-deny]')).not.toBeNull();
  });

  it('fires onBrush with the clicked bucket window', () => {
    let picked: TimeWindow | null = null;
    const { container } = render(
      <TrafficTimeline events={[evt({ at: 150 })]} window={WINDOW} bucketCount={10} onBrush={(w) => (picked = w)} />,
    );
    fireEvent.click(container.querySelectorAll('[data-pyric-bucket]')[1]);
    expect(picked).toEqual({ start: 100, end: 200 });
  });

  it('shows a direct bucket summary on pointer hover and keyboard focus', () => {
    const { container, getByText, queryByText } = render(
      <TrafficTimeline
        events={[evt({ at: 150 }), evt({ at: 160, result: 'deny' })]}
        window={WINDOW}
        bucketCount={10}
        onBrush={() => {}}
        renderBucketSummary={(bucket) => <span>{`${bucket.count} requests · ${bucket.denies} denied`}</span>}
      />,
    );
    const bucket = container.querySelectorAll('[data-pyric-bucket]')[1];

    expect(queryByText('2 requests · 1 denied')).toBeNull();
    fireEvent.pointerEnter(bucket);
    expect(getByText('2 requests · 1 denied')).toBeTruthy();
    fireEvent.pointerLeave(bucket);
    expect(queryByText('2 requests · 1 denied')).toBeNull();
    fireEvent.focus(bucket);
    expect(getByText('2 requests · 1 denied')).toBeTruthy();
    fireEvent.blur(bucket);
    expect(queryByText('2 requests · 1 denied')).toBeNull();
  });

  it('does not make bars interactive without onBrush', () => {
    const { container } = render(
      <TrafficTimeline events={[evt({ at: 150 })]} window={WINDOW} bucketCount={10} />,
    );
    const bar = container.querySelectorAll('[data-pyric-bucket]')[0] as HTMLButtonElement;
    expect(bar.disabled).toBe(true);
  });

  it('positions the brush overlay as left/right fractions of the window', () => {
    const { container } = render(
      <TrafficTimeline
        events={[evt({ at: 150 })]}
        window={WINDOW}
        bucketCount={10}
        brush={{ start: 600, end: 1000 }}
      />,
    );
    const brush = container.querySelector('[data-pyric-brush]') as HTMLElement;
    expect(brush.style.getPropertyValue('--pyric-brush-left')).toBe('0.6');
    expect(brush.style.getPropertyValue('--pyric-brush-right')).toBe('0');
  });

  it('renders the live edge marker at window.end by default', () => {
    const { container } = render(
      <TrafficTimeline events={[evt({ at: 150 })]} window={WINDOW} bucketCount={10} />,
    );
    const live = container.querySelector('[data-pyric-live]') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.style.getPropertyValue('--pyric-live-x')).toBe('1');
  });

  it('hides the live marker when liveAt is null', () => {
    const { container } = render(
      <TrafficTimeline
        events={[evt({ at: 150 })]}
        window={WINDOW}
        bucketCount={10}
        liveAt={null}
      />,
    );
    expect(container.querySelector('[data-pyric-live]')).toBeNull();
  });

  it('renders the header and axis slots', () => {
    const { container } = render(
      <TrafficTimeline
        events={[evt({ at: 150 })]}
        window={WINDOW}
        bucketCount={10}
        header={<span>142 requests</span>}
        axis={(w) => <span>{w.start}</span>}
      />,
    );
    expect(
      container.querySelector('[data-pyric-timeline-header]')!.textContent,
    ).toBe('142 requests');
    expect(
      container.querySelector('[data-pyric-timeline-axis]')!.textContent,
    ).toBe('0');
  });

  it('accepts pre-bucketed counts via the buckets prop', () => {
    const buckets = {
      buckets: [
        {
          index: 0,
          start: 0,
          end: 1000,
          count: 7,
          denies: 2,
          allows: 5,
          heightRatio: 1,
          denyHeightRatio: 0.28,
        },
      ],
      total: 7,
      denies: 2,
      maxCount: 7,
      outOfWindow: 0,
    };
    const { container } = render(
      // events omitted — buckets takes precedence.
      <TrafficTimeline buckets={buckets} window={WINDOW} />,
    );
    const bars = container.querySelectorAll('[data-pyric-bucket]');
    expect(bars.length).toBe(1);
    expect(bars[0].getAttribute('data-pyric-bucket-count')).toBe('7');
  });
});
