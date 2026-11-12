import { describe, expect, it } from 'bun:test';
import { DataSnapshot, RtdbRuleRuntimeError } from '../../../src/rtdb/grammar/data-snapshot.js';

describe('DataSnapshot', () => {
  it('records only leaf or subtree paths actually inspected when an observer is supplied', () => {
    const reads: string[] = [];
    const root = new DataSnapshot(
      {
        workspaces: {
          'ws-1': {
            members: { 'u-1': true },
            title: 'Alpha',
            count: 3,
            ranked: { '.value': 'top', '.priority': 10 },
          },
        },
      },
      '/',
      undefined,
      (path) => reads.push(path),
    );

    const ws = root.child('workspaces/ws-1');
    expect(reads).toEqual([]);

    expect(ws.hasChild('members/u-1')).toBe(true);
    expect(reads).toEqual(['/workspaces/ws-1/members/u-1']);

    reads.length = 0;
    expect(ws.hasChildren(['missing', 'title'])).toBe(false);
    expect(reads).toEqual(['/workspaces/ws-1/missing']);

    reads.length = 0;
    expect(ws.hasChildren()).toBe(true);
    expect(reads).toEqual(['/workspaces/ws-1']);

    reads.length = 0;
    expect(ws.child('title').isString()).toBe(true);
    expect(ws.child('count').isNumber()).toBe(true);
    expect(ws.child('members/u-1').isBoolean()).toBe(true);
    expect(ws.child('ranked').getPriority()).toBe(10);
    expect(reads).toEqual([
      '/workspaces/ws-1/title',
      '/workspaces/ws-1/count',
      '/workspaces/ws-1/members/u-1',
      '/workspaces/ws-1/ranked',
    ]);

    reads.length = 0;
    const member = ws.child('members/u-1');
    expect(member.parent().parent().child('archived').exists()).toBe(false);
    expect(reads).toEqual(['/workspaces/ws-1/archived']);
  });

  it('throws RtdbRuleRuntimeError when calling parent() on the root snapshot', () => {
    const root = new DataSnapshot({ a: 1 });
    expect(() => root.parent()).toThrow(RtdbRuleRuntimeError);
  });

  it('short-circuits exists, hasChildren, type predicates, and getPriority without cloning uninspected subtrees', () => {
    let coldReads = 0;
    const raw: Record<string, unknown> = {
      active: { flag: true },
      '.priority': 7,
    };
    Object.defineProperty(raw, 'coldSubtree', {
      enumerable: true,
      get() {
        coldReads += 1;
        return { big: 'payload' };
      },
    });

    const reads: string[] = [];
    const snap = new DataSnapshot(raw, '/rootNode', undefined, (p) => reads.push(p));

    expect(snap.exists()).toBe(true);
    expect(snap.hasChildren()).toBe(true);
    expect(snap.isString()).toBe(false);
    expect(snap.isNumber()).toBe(false);
    expect(snap.isBoolean()).toBe(false);
    expect(snap.getPriority()).toBe(7);
    expect(coldReads).toBe(0);
    expect(reads).toEqual([
      '/rootNode',
      '/rootNode',
      '/rootNode',
      '/rootNode',
      '/rootNode',
      '/rootNode',
    ]);

    // Priority-only or empty wrapper nodes still report absent (capture rules-rtdb-r20).
    const priorityOnly = new DataSnapshot({ '.priority': 5 }, '/empty');
    expect(priorityOnly.exists()).toBe(false);
    expect(priorityOnly.hasChildren()).toBe(false);
    expect(priorityOnly.getPriority()).toBeNull();

    const wrappedLeaf = new DataSnapshot({ '.value': 'hello', '.priority': 3 }, '/leaf');
    expect(wrappedLeaf.exists()).toBe(true);
    expect(wrappedLeaf.hasChildren()).toBe(false);
    expect(wrappedLeaf.isString()).toBe(true);
    expect(wrappedLeaf.getPriority()).toBe(3);
  });
});
