import { describe, expect, test } from 'bun:test';
import { Timestamp, doc, getAdminFirestore, setDoc } from 'pyric/firestore';
import { Timestamp as RulesTimestamp } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { captureSandboxSnapshot } from 'pyric/sandbox/internal';
import {
  namesFromState,
  recordsAt,
  rtdbReadOnlySitesFromState,
  sitesFromState,
} from '../../../src/assurance-surface/probes/state.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';

describe('rtdbReadOnlySitesFromState', () => {
  const readSite: AccessSite = {
    service: 'rtdb',
    op: 'query',
    path: 'rooms/$roomId/events',
    source: 'feed.ts:8',
    resolution: 'resolved',
    pathVariables: [{ name: 'roomId' }],
  };

  test('derives a seed site at ${path}/$itemId when seeded RTDB items carry a known user uid and have no client write', () => {
    const state = {
      rtdb: {
        rooms: {
          r1: {
            events: {
              e1: { actorUid: 'u-alice', message: 'hello', at: 100 },
            },
          },
        },
      },
    };
    const sites = rtdbReadOnlySitesFromState([readSite], state, ['u-alice', 'u-bob']);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      service: 'rtdb',
      op: 'set',
      path: 'rooms/$roomId/events/$itemId',
      source: 'seed:rooms/r1/events/e1',
      resolution: 'resolved',
      pathVariables: [{ name: 'roomId' }, { name: 'itemId' }],
    });
    expect(sites[0].payload?.fields).toEqual([
      { name: 'actorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
      { name: 'message', kind: 'string' },
      { name: 'at', kind: 'number' },
    ]);
  });

  test('returns empty when a client write covers the read path or when no seeded item carries a known uid', () => {
    const writeSite: AccessSite = {
      service: 'rtdb',
      op: 'push',
      path: 'rooms/$roomId/events/$pushId',
      source: 'feed.ts:15',
      resolution: 'resolved',
    };
    const state = {
      rtdb: {
        rooms: {
          r1: {
            events: {
              e1: { actorUid: 'u-alice', message: 'hello' },
            },
          },
        },
      },
    };
    expect(rtdbReadOnlySitesFromState([readSite, writeSite], state, ['u-alice'])).toEqual([]);
    expect(rtdbReadOnlySitesFromState([readSite], undefined, ['u-alice'])).toEqual([]);
    expect(rtdbReadOnlySitesFromState([readSite], { rtdb: { rooms: { r1: {} } } }, ['u-alice'])).toEqual([]);
    expect(
      rtdbReadOnlySitesFromState(
        [readSite],
        { rtdb: { rooms: { r1: { events: { e1: { message: 'system' } } } } } },
        ['u-alice'],
      ),
    ).toEqual([]);
  });
});

describe('recordsAt', () => {
  test('matches default headers and affixed variables while isolating named resources', () => {
    const state = {
      firestore: {
        'items/item_alpha': { owner: 'u-alice' },
        'items/other': { owner: 'u-bob' },
      },
      rtdb: {
        users: {
          user_alice: { role: 'member' },
          plain: { role: 'guest' },
        },
      },
    };
    expect(recordsAt('firestore', '/databases/(default)/documents/items/item_{id}', state)).toEqual([
      { path: 'items/item_alpha', data: { owner: 'u-alice' } },
    ]);
    expect(recordsAt('firestore', '/databases/analytics-db/documents/items/{id}', state)).toEqual([]);
    expect(recordsAt('rtdb', 'users/user_{uid}', state)).toEqual([
      { path: 'users/user_alice', data: { role: 'member' } },
    ]);
    expect(recordsAt('rtdb', 'https://secondary-rtdb.firebaseio.com/users/$uid', state)).toEqual([]);
  });
});

describe('snapshot marker decoding and timestamp classification in state.ts', () => {
  test('recursively unwraps pyric/map/1.0, decodes pyric/number/1.0, and classifies Timestamp values as serverTimestamp', async () => {
    const sandbox = initializeSandbox();
    try {
      const fs = getAdminFirestore(sandbox);
      await setDoc(doc(fs, 'orgs/acme/items/i-1'), {
        ownerId: 'u-alice',
        createdAt: Timestamp.fromMillis(1_700_000_000_000),
        score: -0,
        author: { type: 'profile', name: 'Alice Chen' },
        badges: [{ type: 'badge', label: 'lead' }],
        fakeTsMap: { type: 'firestore/timestamp/1.0', seconds: 1, nanoseconds: 0 },
      });
      const snapshot = await captureSandboxSnapshot(sandbox);

      const sites = sitesFromState({ snapshot }, ['u-alice']);
      expect(sites).toHaveLength(1);
      const fieldsByName = new Map(sites[0]!.payload?.fields.map((f) => [f.name, f.kind]));
      expect(fieldsByName.get('createdAt')).toBe('serverTimestamp');
      expect(fieldsByName.get('score')).toBe('number');
      expect(fieldsByName.get('author')).toBe('object');
      expect(fieldsByName.get('badges')).toBe('array');
      expect(fieldsByName.get('fakeTsMap')).toBe('object');

      const records = recordsAt('firestore', 'orgs/{orgId}/items/{itemId}', { snapshot });
      expect(records).toHaveLength(1);
      const recordData = records[0]!.data as Record<string, unknown>;
      expect(recordData.author).toEqual({ type: 'profile', name: 'Alice Chen' });
      expect(recordData.badges).toEqual([{ type: 'badge', label: 'lead' }]);
      expect(Object.is(recordData.score, -0)).toBe(true);

      const siteForNames: AccessSite = {
        service: 'firestore',
        op: 'setDoc',
        path: 'orgs/{orgId}/items/{itemId}',
        source: 'items.ts:1',
        resolution: 'resolved',
        payload: {
          kind: 'object',
          open: false,
          fields: [
            { name: 'ownerId', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
            {
              name: 'author.name',
              kind: 'string',
              auth: [{ source: 'auth.displayName', certainty: 'exact' }],
            },
          ],
        },
      };
      const names = namesFromState([siteForNames], { snapshot }, ['u-alice']);
      expect(names.get('u-alice')).toBe('Alice Chen');
    } finally {
      sandbox.dispose();
    }
  });

  test('classifies live Timestamp, RulesTimestamp, and raw timestamp markers in state.firestore as serverTimestamp', () => {
    const sites = sitesFromState(
      {
        firestore: {
          '/items/i-1': {
            sdkTs: Timestamp.fromMillis(1_700_000_000_000),
            rulesTs: new RulesTimestamp(1_700_000_000, 0),
            tagMarker: { type: 'firestore/timestamp/1.0', seconds: 100, nanoseconds: 0 },
            dunderMarker: { __type: 'timestamp', seconds: 200, nanos: 0 },
            negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
          },
        },
      },
      ['u-alice'],
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.source).toBe('seed:items/i-1');
    const fieldsByName = new Map(sites[0]!.payload?.fields.map((f) => [f.name, f.kind]));
    expect(fieldsByName.get('sdkTs')).toBe('serverTimestamp');
    expect(fieldsByName.get('rulesTs')).toBe('serverTimestamp');
    expect(fieldsByName.get('tagMarker')).toBe('serverTimestamp');
    expect(fieldsByName.get('dunderMarker')).toBe('serverTimestamp');
    expect(fieldsByName.get('negInf')).toBe('number');
  });
});

