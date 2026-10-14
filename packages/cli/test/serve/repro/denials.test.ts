import { describe, expect, it } from 'bun:test';
import { listDenials, formatDenials } from '../../../src/serve/repro/denials.js';
import type { ReproFile } from '../../../src/serve/repro/format.js';

const context = (path: string, uid: string) => ({
  engine: 'rtdb',
  auth: { uid },
  reasons: ['no .read granted'],
  request: { method: 'listen', path },
  matchedPath: '/rooms/$roomId',
  matchedRule: "auth != null && data.child('members').child(auth.uid).exists()",
});

function repro(entries: unknown[]): ReproFile {
  return {
    schema: 'pyric.repro.v1', createdAt: '', recordedBy: 'test', truncated: false,
    base: { subscriptions: {} },
    entries,
  } as unknown as ReproFile;
}

const sub = (at: number, subId: string, instance: string | undefined, path: string) => ({
  kind: 'in', at, session: 's1', frame: { t: 'sub', subId, target: { service: 'rtdb', instance, path } },
});
const denied = (at: number, subId: string, path: string, uid: string) => ({
  kind: 'out', at, session: 's1',
  frame: { t: 'snap', subId, value: { __error: { code: 'permission-denied', message: 'denied', denialContext: context(path, uid) } } },
});

describe('listDenials', () => {
  const file = repro([
    sub(1000, 'a', 'demo-app-shard-1', '/rooms/r1'),
    denied(1001, 'a', '/rooms/r1', 'u1'),
    sub(2000, 'b', undefined, '/rooms/r2'),
    denied(2001, 'b', '/rooms/r2', 'u1'),
    sub(3000, 'c', 'demo-app-shard-1', '/rooms/r3'),
    denied(3001, 'c', '/rooms/r3', 'u2'),
  ]);

  it('groups by service, instance, rule node and rule, naming each instance', () => {
    const groups = listDenials(file, {});
    const shard = groups.find((g) => g.instance === 'demo-app-shard-1');
    expect(shard).toMatchObject({ service: 'rtdb', path: '/rooms/$roomId', count: 2, firstAt: 1001, lastAt: 3001, identities: ['u1', 'u2'] });
    expect(shard?.rule).toContain('members');
    expect(shard?.trace).toEqual(['no .read granted']);
    expect(groups.find((g) => g.instance === undefined)?.count).toBe(1);
  });

  it('counts the page loads a denial recurs on, separating a one-off from a recurring one', () => {
    const inSession = <T extends { session: string }>(entry: T, session: string): T => ({ ...entry, session });
    const loads = repro([
      // A stale reference the app re-subscribes to on every load: three loads.
      inSession(sub(1000, 'a', 'demo-app-shard-1', '/rooms/r1'), 'load-1'),
      inSession(denied(1001, 'a', '/rooms/r1', 'u1'), 'load-1'),
      inSession(sub(2000, 'a', 'demo-app-shard-1', '/rooms/r1'), 'load-2'),
      inSession(denied(2001, 'a', '/rooms/r1', 'u1'), 'load-2'),
      inSession(sub(3000, 'a', 'demo-app-shard-1', '/rooms/r1'), 'load-3'),
      inSession(denied(3001, 'a', '/rooms/r1', 'u1'), 'load-3'),
      // A race on one load, denied twice there and never again.
      inSession(sub(1500, 'b', undefined, '/rooms/r2'), 'load-1'),
      inSession(denied(1501, 'b', '/rooms/r2', 'u1'), 'load-1'),
      inSession(denied(1502, 'b', '/rooms/r2', 'u1'), 'load-1'),
    ]);
    const groups = listDenials(loads, {});
    expect(groups.find((g) => g.instance === 'demo-app-shard-1')).toMatchObject({ count: 3, loads: 3 });
    expect(groups.find((g) => g.instance === undefined)).toMatchObject({ count: 2, loads: 1 });
    const text = formatDenials(groups);
    expect(text).toContain('rtdb demo-app-shard-1 /rooms/$roomId: 3 denials on 3 page loads');
    expect(text).toContain('rtdb /rooms/$roomId: 2 denials on 1 page load');
  });

  it('keeps a denial whose request left the bounded log apart from the default instance', () => {
    const groups = listDenials(repro([
      sub(1000, 'b', undefined, '/rooms/r2'),
      denied(1001, 'b', '/rooms/r2', 'u1'),
      // The request that opened 'gone' was dropped with an older window.
      denied(1002, 'gone', '/rooms/r9', 'u1'),
    ]), {});
    expect(groups.map((g) => [g.instance, g.instanceUnknown === true, g.count])).toEqual([
      [undefined, false, 1],
      [undefined, true, 1],
    ]);
    expect(formatDenials(groups)).toContain('rtdb (instance unknown) /rooms/$roomId: 1 denial');
  });

  it('groups Firestore denials by the rule that decided, listing each denied document', () => {
    const firestoreDenied = (at: number, id: string, path: string) => ({
      kind: 'out', at, session: 's1',
      frame: { t: 'res', id, ok: false, error: { code: 'permission-denied', message: 'denied', denialContext: {
        auth: null,
        reasons: ['allow read: false'],
        request: { method: 'get', path },
        rule: { line: 5, col: 7, citation: 'firestore.rules:5:7', expression: 'request.auth.uid == userId' },
      } } },
    });
    const groups = listDenials(repro([
      firestoreDenied(1000, 'op-1', 'users/a'),
      firestoreDenied(1001, 'op-2', 'users/b'),
    ]), {});
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      service: 'firestore', path: 'firestore.rules:5:7', rule: 'request.auth.uid == userId', count: 2, paths: ['users/a', 'users/b'],
    });
    expect(formatDenials(groups)).toContain('  denied: users/a, users/b');
  });

  it('collects the trace of every denial in a group, each line once', () => {
    const groups = listDenials(repro([
      sub(1000, 'a', undefined, '/rooms/r1'),
      denied(1001, 'a', '/rooms/r1', 'u1'),
      sub(2000, 'b', undefined, '/rooms/r2'),
      { ...denied(2001, 'b', '/rooms/r2', 'u2'), frame: { t: 'snap', subId: 'b', value: { __error: { code: 'permission-denied', message: 'denied', denialContext: { ...context('/rooms/r2', 'u2'), reasons: ['no .read granted', 'auth is null'] } } } } },
    ]), {});
    expect(groups[0]?.trace).toEqual(['no .read granted', 'auth is null']);
    expect(groups[0]?.paths).toEqual(['/rooms/r1', '/rooms/r2']);
  });

  it('does not count an agent tool call as a page load', () => {
    const groups = listDenials(repro([
      { kind: 'in', at: 1000, session: 'mcp:agent-1', frame: { t: 'tool', id: 't1', name: 'rtdb_simulate_access', args: {} } },
      {
        kind: 'out', at: 1001, session: 'mcp:agent-1',
        frame: { t: 'res', id: 't1', ok: false, error: { code: 'permission-denied', message: 'denied', denialContext: context('/rooms/r1', 'u1') } },
      },
      sub(2000, 'a', undefined, '/rooms/r1'),
      denied(2001, 'a', '/rooms/r1', 'u1'),
    ]), {});
    expect(groups[0]).toMatchObject({ count: 2, loads: 1 });
  });

  it('honours --since and --service', () => {
    expect(listDenials(file, { sinceAt: 2500 }).map((g) => g.count)).toEqual([1]);
    expect(listDenials(file, { service: 'firestore' })).toEqual([]);
  });

  it('prints one block per group with the instance', () => {
    const text = formatDenials(listDenials(file, {}));
    expect(text).toContain('rtdb demo-app-shard-1 /rooms/$roomId');
    expect(text).toContain('2 denials');
  });
});
