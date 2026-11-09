import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  TrafficCapNotice,
  TrafficTimeFocusBanner,
  formatTrafficWindowRange,
  shouldShowCapNotice,
} from '../../../src/features/traffic/TrafficNotices.js';

afterEach(() => {
  cleanup();
});

describe('TrafficNotices', () => {
  it('shows rolling-cap notice when unfocused and capped, or when a focused window starts before uncoveredBeforeAt', () => {
    expect(shouldShowCapNotice(false, null, null)).toBe(false);
    expect(shouldShowCapNotice(true, 5_000, null)).toBe(true);
    expect(shouldShowCapNotice(false, null, { start: 1_000, end: 2_000 })).toBe(false);
    // Chatty delivery lane (`unfocusedCapped = false`) still warns when focused interval precedes oldest retained delivery:
    expect(shouldShowCapNotice(false, 5_000, { start: 4_999, end: 5_500 })).toBe(true);
    // Focused interval starting at or after oldest retained row (`5_000`) has no evicted events:
    expect(shouldShowCapNotice(true, 5_000, { start: 5_000, end: 6_000 })).toBe(false);
    expect(shouldShowCapNotice(true, 5_000, { start: 7_000, end: 8_000 })).toBe(false);
  });

  it('renders scope-specific rolling-cap copy and interactive time-focus banner', () => {
    let cleared = 0;
    const window = { start: 1_700_000_000_000, end: 1_700_000_060_000 };
    const view = render(
      <div>
        <TrafficTimeFocusBanner
          focus={{
            window,
            finding: '3 requests occurred in this interval; none were denied.',
            onClear: () => {
              cleared += 1;
            },
          }}
        />
        <TrafficCapNotice capped={true} scope="all" />
        <TrafficCapNotice capped={true} scope="rules" />
      </div>,
    );

    expect(view.getByText(formatTrafficWindowRange(window))).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Show all traffic' }));
    expect(cleared).toBe(1);

    const notices = Array.from(view.container.querySelectorAll('[data-pyric-traffic-capped]')).map(
      (node) => node.textContent ?? '',
    );
    expect(notices[0]).toContain('retained requests per traffic lane');
    expect(notices[1]).toContain('retained client requests');
  });
});
