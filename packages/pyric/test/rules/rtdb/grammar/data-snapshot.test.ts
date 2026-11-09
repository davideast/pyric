import { describe, expect, it } from 'bun:test';
import { DataSnapshot, RtdbRuleRuntimeError } from '../../../../src/rules/rtdb/grammar/data-snapshot.js';

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
});
