/**
 * The drill-in route, read back through the shell's own URL codec: a URL the
 * inspector wrote has to decode to the same listener, and the Traffic tab
 * strip has to stay on Listeners while it is open.
 */
import { describe, expect, it } from 'bun:test';
import { parsePath } from '../../../src/shell/path.js';
import {
  drilledListenerId,
  listenerDrillTarget,
} from '../../../src/features/listeners/listener-links.js';
import { hrefFor } from '../../../src/shell/router.js';
import { trafficTabForLocation } from '../../../src/features/traffic/TrafficSurface.js';

function locationFor(url: string) {
  const queryAt = url.indexOf('?');
  return parsePath(
    queryAt === -1 ? url : url.slice(0, queryAt),
    queryAt === -1 ? '' : url.slice(queryAt),
    '/',
  );
}

describe('the drill-in route', () => {
  it('round-trips the listener the inspector linked to', () => {
    const href = hrefFor(listenerDrillTarget('l-7'));
    expect(href).toBe('/traffic/listeners/l-7');
    expect(drilledListenerId(locationFor(href))).toBe('l-7');
  });

  it('round-trips an id that needs encoding', () => {
    const href = hrefFor(listenerDrillTarget('listener 7/8'));
    expect(drilledListenerId(locationFor(href))).toBe('listener 7/8');
  });

  it('keeps the Listeners tab selected while the page is open', () => {
    expect(trafficTabForLocation(locationFor('/traffic/listeners/l-7'))).toBe('listeners');
  });

  it('leaves the tab deep link alone', () => {
    expect(trafficTabForLocation(locationFor('/traffic?view=listeners&listener=l-7'))).toBe(
      'listeners',
    );
    expect(drilledListenerId(locationFor('/traffic?view=listeners&listener=l-7'))).toBeUndefined();
  });

  it('resolves the other Traffic views unchanged', () => {
    expect(trafficTabForLocation(locationFor('/traffic'))).toBe('timeline');
    expect(trafficTabForLocation(locationFor('/traffic?view=billable'))).toBe('billable');
    expect(trafficTabForLocation(locationFor('/traffic?view=rules'))).toBe('rules');
    expect(trafficTabForLocation(locationFor('/firestore/notes/one'))).toBe('timeline');
  });
});
