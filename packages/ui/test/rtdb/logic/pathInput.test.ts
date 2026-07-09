import { describe, expect, test } from 'bun:test';
import { parseRtdbPathInput, rtdbCrumbs } from '../../../src/rtdb/index.js';

describe('parseRtdbPathInput', () => {
  test('normalizes plain paths with or without leading slash', () => {
    expect(parseRtdbPathInput('rooms/r1')).toBe('/rooms/r1');
    expect(parseRtdbPathInput('/rooms/r1')).toBe('/rooms/r1');
    expect(parseRtdbPathInput('  rooms//r1/ ')).toBe('/rooms/r1');
  });

  test('empty or slash-only input is the root', () => {
    expect(parseRtdbPathInput('')).toBe('/');
    expect(parseRtdbPathInput('   ')).toBe('/');
    expect(parseRtdbPathInput('/')).toBe('/');
    expect(parseRtdbPathInput('///')).toBe('/');
  });

  test('strips a pasted URL origin', () => {
    expect(parseRtdbPathInput('https://demo.firebaseio.com/rooms/r1')).toBe('/rooms/r1');
    expect(parseRtdbPathInput('http://localhost:4000/rooms')).toBe('/rooms');
    expect(parseRtdbPathInput('https://demo.firebaseio.com')).toBe('/');
  });

  test('drops query and hash tails', () => {
    expect(parseRtdbPathInput('/rooms/r1?print=pretty')).toBe('/rooms/r1');
    expect(parseRtdbPathInput('rooms#frag')).toBe('/rooms');
  });
});

describe('rtdbCrumbs', () => {
  test('root has no segment crumbs', () => {
    expect(rtdbCrumbs('/')).toEqual([]);
  });

  test('yields one crumb per segment with cumulative paths', () => {
    expect(rtdbCrumbs('/rooms/r1/messages')).toEqual([
      { label: 'rooms', path: '/rooms' },
      { label: 'r1', path: '/rooms/r1' },
      { label: 'messages', path: '/rooms/r1/messages' },
    ]);
  });

  test('normalizes before deriving crumbs', () => {
    expect(rtdbCrumbs('rooms//r1/')).toEqual([
      { label: 'rooms', path: '/rooms' },
      { label: 'r1', path: '/rooms/r1' },
    ]);
  });
});
