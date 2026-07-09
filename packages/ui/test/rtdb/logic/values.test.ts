import { describe, expect, test } from 'bun:test';
import {
  formatRtdbJson,
  hasRtdbChildren,
  isRtdbObjectValue,
  joinRtdbPath,
  normalizeRtdbPath,
  parentRtdbPath,
  parseRtdbJson,
  previewRtdbValue,
  relativeRtdbPath,
  rtdbChildEntries,
  rtdbPathSegments,
  rtdbValueAt,
  rtdbValueKind,
} from '../../../src/rtdb/index.js';

describe('RTDB path helpers', () => {
  test('normalizes and joins RTDB paths', () => {
    expect(normalizeRtdbPath('///rooms/r1//messages/')).toBe('/rooms/r1/messages');
    expect(rtdbPathSegments('/rooms/r1/messages')).toEqual(['rooms', 'r1', 'messages']);
    expect(joinRtdbPath('/rooms/r1', '/messages/m1')).toBe('/rooms/r1/messages/m1');
    expect(parentRtdbPath('/rooms/r1/messages')).toBe('/rooms/r1');
    expect(parentRtdbPath('/rooms')).toBe('/');
  });

  test('resolves paths relative to a view root', () => {
    expect(relativeRtdbPath('/', '/rooms/r1')).toBe('/rooms/r1');
    expect(relativeRtdbPath('/rooms', '/rooms')).toBe('/');
    expect(relativeRtdbPath('/rooms', '/rooms/r1/title')).toBe('/r1/title');
    expect(relativeRtdbPath('/rooms', '/users/u1')).toBeNull();
    expect(relativeRtdbPath('/rooms/r1', '/rooms')).toBeNull();
    // Segment-boundary check: /rooms2 is NOT under /rooms.
    expect(relativeRtdbPath('/rooms', '/rooms2/x')).toBeNull();
  });
});

describe('RTDB value helpers', () => {
  test('reads values and sorted child entries from a tree', () => {
    const tree = {
      rooms: {
        b: { title: 'Beta' },
        a: { title: 'Alpha' },
      },
    };
    expect(rtdbValueAt(tree, '/rooms/a/title')).toBe('Alpha');
    expect(rtdbValueAt(tree, '/rooms/missing')).toBeNull();
    expect(rtdbChildEntries(rtdbValueAt(tree, '/rooms')).map(([key]) => key)).toEqual(['a', 'b']);
  });

  test('sorts child keys numeric-aware (console order: 2 before 10)', () => {
    const value = { '10': 'j', '2': 'b', a: 'x' };
    expect(rtdbChildEntries(value).map(([key]) => key)).toEqual(['2', '10', 'a']);
  });

  test('formats, parses, and previews RTDB values', () => {
    expect(parseRtdbJson('')).toBeNull();
    expect(parseRtdbJson('{"ready":true}')).toEqual({ ready: true });
    expect(formatRtdbJson(undefined)).toBe('null');
    expect(rtdbValueKind(['a'])).toBe('array');
    expect(previewRtdbValue({ child: true })).toBe('1 child');
    expect(previewRtdbValue(['a', 'b'])).toBe('2 items');
  });

  test('recognizes RTDB object values without treating arrays as objects', () => {
    expect(isRtdbObjectValue({})).toBe(true);
    expect(isRtdbObjectValue([])).toBe(false);
    expect(isRtdbObjectValue(null)).toBe(false);
  });

  test('hasRtdbChildren treats arrays and non-empty objects as parents', () => {
    expect(hasRtdbChildren({ a: 1 })).toBe(true);
    expect(hasRtdbChildren(['a'])).toBe(true);
    expect(hasRtdbChildren({})).toBe(false);
    expect(hasRtdbChildren('scalar')).toBe(false);
    expect(hasRtdbChildren(null)).toBe(false);
  });
});
