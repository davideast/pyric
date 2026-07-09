import { describe, expect, test } from 'bun:test';
import {
  initialRtdbTree,
  isRtdbPathExpanded,
  rtdbTreeReducer,
  rtdbTreeValueAt,
  rtdbVisibleChildren,
  type RtdbTreeState,
} from '../../../src/rtdb/index.js';

const value = (state: RtdbTreeState, v: unknown) =>
  rtdbTreeReducer(state, { type: 'value', path: state.path, value: v });

describe('rtdbTreeReducer: navigate + value', () => {
  test('starts loading and goes live on the first snapshot', () => {
    const s0 = initialRtdbTree('/rooms');
    expect(s0.status).toBe('loading');
    const s1 = value(s0, { r1: { title: 'Alpha' } });
    expect(s1.status).toBe('live');
    expect(rtdbTreeValueAt(s1, '/rooms/r1/title')).toBe('Alpha');
  });

  test('navigate resets to a fresh loading state; same path keeps state', () => {
    let s = value(initialRtdbTree('/'), { rooms: { r1: {} } });
    s = rtdbTreeReducer(s, { type: 'expand', path: '/rooms' });
    const same = rtdbTreeReducer(s, { type: 'navigate', path: '///' });
    expect(same).toBe(s);
    const moved = rtdbTreeReducer(s, { type: 'navigate', path: '/rooms' });
    expect(moved.path).toBe('/rooms');
    expect(moved.status).toBe('loading');
    expect(moved.expanded).toEqual({});
  });

  test('normalizes an empty-object snapshot to null at ingestion (empty DB)', () => {
    const s = value(initialRtdbTree('/'), {});
    expect(s.status).toBe('live');
    expect(s.value).toBeNull();
    // Nested empties prune on the way in, too.
    const nested = value(initialRtdbTree('/'), { rooms: {}, version: 1 });
    expect(nested.value).toEqual({ version: 1 });
  });

  test('ignores a snapshot from a superseded subscription (stale path)', () => {
    const s = initialRtdbTree('/rooms');
    const stale = rtdbTreeReducer(s, { type: 'value', path: '/', value: { x: 1 } });
    expect(stale).toBe(s);
  });

  test('error marks the state; stale-path errors are ignored', () => {
    const s = initialRtdbTree('/rooms');
    const err = rtdbTreeReducer(s, { type: 'error', path: '/rooms', message: 'boom' });
    expect(err.status).toBe('error');
    expect(err.error).toBe('boom');
    expect(rtdbTreeReducer(s, { type: 'error', path: '/', message: 'x' })).toBe(s);
  });
});

describe('rtdbTreeReducer: expand / collapse / toggle', () => {
  const base = value(initialRtdbTree('/'), {
    rooms: { r1: { title: 'Alpha' } },
  });

  test('expand and collapse manage descendant paths; toggle flips', () => {
    let s = rtdbTreeReducer(base, { type: 'expand', path: '/rooms' });
    expect(isRtdbPathExpanded(s, '/rooms')).toBe(true);
    s = rtdbTreeReducer(s, { type: 'toggle', path: '/rooms' });
    expect(isRtdbPathExpanded(s, '/rooms')).toBe(false);
    s = rtdbTreeReducer(s, { type: 'toggle', path: '/rooms' });
    expect(isRtdbPathExpanded(s, '/rooms')).toBe(true);
    s = rtdbTreeReducer(s, { type: 'collapse', path: '/rooms' });
    expect(isRtdbPathExpanded(s, '/rooms')).toBe(false);
  });

  test('the view root is always expanded and never enters the set', () => {
    expect(isRtdbPathExpanded(base, '/')).toBe(true);
    const s = rtdbTreeReducer(base, { type: 'expand', path: '/' });
    expect(s).toBe(base);
    expect(s.expanded).toEqual({});
  });
});

describe('rtdbTreeReducer: update-merge (live snapshot over expanded state)', () => {
  test('keeps expansion for surviving paths, prunes vanished/scalar-ified ones', () => {
    let s = value(initialRtdbTree('/'), {
      rooms: { r1: { title: 'Alpha' } },
      users: { u1: { name: 'Ada' } },
    });
    s = rtdbTreeReducer(s, { type: 'expand', path: '/rooms' });
    s = rtdbTreeReducer(s, { type: 'expand', path: '/rooms/r1' });
    s = rtdbTreeReducer(s, { type: 'expand', path: '/users' });

    // Live write: /users deleted, /rooms/r1 became a scalar, /rooms survives.
    s = value(s, { rooms: { r1: 'gone-scalar' } });
    expect(isRtdbPathExpanded(s, '/rooms')).toBe(true);
    expect(s.expanded['/rooms/r1']).toBeUndefined();
    expect(s.expanded['/users']).toBeUndefined();
  });

  test('prunes paging state alongside expansion', () => {
    let s = value(initialRtdbTree('/'), { list: { a: 1, b: 2 } });
    s = rtdbTreeReducer(s, { type: 'show-more', path: '/list', pageSize: 1 });
    expect(s.pages['/list']).toBe(2);
    s = value(s, { other: true });
    expect(s.pages['/list']).toBeUndefined();
  });
});

describe('paging (console-style show more)', () => {
  const wide = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [`k${String(i).padStart(3, '0')}`, i]),
  );

  test('caps rendered children at the page size and counts the hidden rest', () => {
    const s = value(initialRtdbTree('/'), { wide });
    const page = rtdbVisibleChildren(s, '/wide', 50);
    expect(page.entries.length).toBe(50);
    expect(page.total).toBe(120);
    expect(page.hiddenCount).toBe(70);
  });

  test('show-more reveals one more page each time, clamped to the total', () => {
    let s = value(initialRtdbTree('/'), { wide });
    s = rtdbTreeReducer(s, { type: 'show-more', path: '/wide', pageSize: 50 });
    expect(rtdbVisibleChildren(s, '/wide', 50).entries.length).toBe(100);
    s = rtdbTreeReducer(s, { type: 'show-more', path: '/wide', pageSize: 50 });
    const page = rtdbVisibleChildren(s, '/wide', 50);
    expect(page.entries.length).toBe(120);
    expect(page.hiddenCount).toBe(0);
  });
});

describe('rtdbTreeValueAt', () => {
  test('resolves absolute paths against a non-root view root', () => {
    const s = value(initialRtdbTree('/rooms/r1'), { title: 'Alpha', tags: { a: true } });
    expect(rtdbTreeValueAt(s, '/rooms/r1')).toEqual({ title: 'Alpha', tags: { a: true } });
    expect(rtdbTreeValueAt(s, '/rooms/r1/title')).toBe('Alpha');
    expect(rtdbTreeValueAt(s, '/elsewhere')).toBeNull();
  });
});
