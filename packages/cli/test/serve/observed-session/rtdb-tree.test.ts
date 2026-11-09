import { describe, expect, it } from 'bun:test';
import {
  canonicalRtdbPath,
  joinRtdbPath,
  mergeRtdbTrees,
  rtdbPathSegments,
  setRtdbAtSegments,
  toRtdbMockData,
} from '../../../src/serve/observed-session/rtdb-tree.js';

describe('rtdb-tree', () => {
  it('normalizes RTDB segments, canonical paths, joined paths, and mockData roots', () => {
    expect(rtdbPathSegments('///rooms//r-1/')).toEqual(['rooms', 'r-1']);
    expect(canonicalRtdbPath('')).toBe('/');
    expect(canonicalRtdbPath('rooms/r-1/')).toBe('/rooms/r-1');
    expect(canonicalRtdbPath(['rooms', 'r-1'])).toBe('/rooms/r-1');
    expect(joinRtdbPath('/rooms/', '/r-1/messages/')).toBe('/rooms/r-1/messages');

    expect(toRtdbMockData(null)).toEqual({});
    expect(toRtdbMockData(undefined)).toEqual({});
    expect(toRtdbMockData(42)).toEqual({ '.value': 42 });
    const source = { rooms: { r1: { open: true } } };
    const cloned = toRtdbMockData(source);
    expect(cloned).toEqual(source);
    (cloned.rooms as Record<string, unknown>).r1 = null;
    expect(source.rooms.r1).toEqual({ open: true });
  });

  it('sets, prunes empty ancestors, and merges RTDB subtrees', () => {
    let tree = setRtdbAtSegments(null, ['rooms', 'r1', 'title'], 'Lobby');
    expect(tree).toEqual({ rooms: { r1: { title: 'Lobby' } } });
    tree = setRtdbAtSegments(tree, ['rooms', 'r1', 'title'], null);
    expect(tree).toBeNull();

    const merged = mergeRtdbTrees({ rooms: { r1: { a: 1, b: 2 } } }, { rooms: { r1: { b: 3, c: 4 } } });
    expect(merged).toEqual({ rooms: { r1: { a: 1, b: 3, c: 4 } } });
  });
});
