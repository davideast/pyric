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
