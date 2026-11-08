import { describe, expect, test } from 'bun:test';
import { rtdbReadOnlySitesFromState } from '../../../src/assurance-surface/probes/state.js';
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

