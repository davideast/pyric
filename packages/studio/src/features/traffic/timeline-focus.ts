import type { TimeWindow, TrafficEvent } from '@pyric/ui/traffic';

export interface TrafficTimeFocus<Event extends TrafficEvent = TrafficEvent> {
  window: TimeWindow;
  events: Event[];
  total: number;
  denies: number;
  finding: string;
}

function focusFinding(total: number, denies: number): string {
  if (total === 0) return 'No requests occurred in this interval.';
  if (total === 1) {
    return denies === 1
      ? 'The request in this interval was denied.'
      : 'One request occurred in this interval; it was not denied.';
  }
  if (denies === 0) return `${total} requests occurred in this interval; none were denied.`;
  if (denies === total) return `All ${total} requests in this interval were denied.`;
  return `${total} requests occurred in this interval; ${denies} ${denies === 1 ? 'was' : 'were'} denied.`;
}

/** Derive the records and observed finding for one half-open timeline bucket. */
export function trafficTimeFocus<Event extends TrafficEvent>(
  events: readonly Event[],
  window: TimeWindow,
): TrafficTimeFocus<Event> {
  const focused = events.filter((event) => event.at >= window.start && event.at < window.end);
  const denies = focused.reduce((count, event) => count + (event.result === 'deny' ? 1 : 0), 0);
  return {
    window,
    events: focused,
    total: focused.length,
    denies,
    finding: focusFinding(focused.length, denies),
  };
}

/** Clicking the pinned bucket again clears it; any other bucket replaces it. */
export function toggleTimeFocus(current: TimeWindow | null, next: TimeWindow): TimeWindow | null {
  return current?.start === next.start && current.end === next.end ? null : next;
}
