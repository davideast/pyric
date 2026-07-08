import { describe, expect, test } from 'bun:test';
import {
  formatRtdbJson,
  isRtdbObjectValue,
  joinRtdbPath,
  normalizeRtdbPath,
  parentRtdbPath,
  parseRtdbJson,
  previewRtdbValue,
  rtdbChildEntries,
  rtdbPathSegments,
  rtdbValueAt,
  rtdbValueKind,
} from '../../src/rtdb/index.js';

describe('RTDB browser value helpers', () => {
  test('normalizes and joins RTDB paths', () => {
    expect(normalizeRtdbPath('///rooms/r1//messages/')).toBe('/rooms/r1/messages');
    expect(rtdbPathSegments('/rooms/r1/messages')).toEqual(['rooms', 'r1', 'messages']);
    expect(joinRtdbPath('/rooms/r1', '/messages/m1')).toBe('/rooms/r1/messages/m1');
    expect(parentRtdbPath('/rooms/r1/messages')).toBe('/rooms/r1');
    expect(parentRtdbPath('/rooms')).toBe('/');
  });

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
});
