/**
 * 1:1 unit tests for `rtdb-write-plan.ts`: stateless RTDB write-target path
 * normalization, multi-path `update` subpath extraction, and shared client/Admin
 * write-lease dispatch.
 */
import { describe, expect, test } from 'bun:test';
import { inFlightRtdbOverlapOf } from '../src/database-inflight-writes.js';
import {
  joinRtdbSubpath,
  normalizeInFlightRtdbPath,
  patchWritePathsOf,
  rtdbWriteLeaseStarter,
  UNREAD_INSTANCE,
} from '../src/rtdb-write-plan.js';

const INSTANCE = 'demo-project-default-rtdb';

describe('rtdb-write-plan', () => {
  test('normalizes RTDB paths, joins subpaths, and extracts target subpaths from multi-path update patches', () => {
    expect(UNREAD_INSTANCE).toBe('instance-not-read-from-the-sdk-reference');
    expect(normalizeInFlightRtdbPath(undefined)).toBe('/');
    expect(normalizeInFlightRtdbPath('///')).toBe('/');
    expect(normalizeInFlightRtdbPath('projects//p1/tasks/')).toBe('/projects/p1/tasks');
    expect(joinRtdbSubpath('/rooms/', ['r1', 'title'])).toBe('/rooms/r1/title');
    expect(joinRtdbSubpath('/', [])).toBe('/');

    expect(patchWritePathsOf('/rooms', null)).toEqual(['/rooms']);
    expect(
      patchWritePathsOf('/rooms', {
        'r1/name': 'Alpha',
        'r2/owner': 'u-1',
        ignored: undefined,
      }),
    ).toEqual(['/rooms/r1/name', '/rooms/r2/owner']);
    expect(patchWritePathsOf('/rooms/r1', { '/': 'whole' })).toEqual(['/rooms/r1']);
  });

  test('dispatches client and Admin write methods to path-scoped leases and ignores reads', () => {
    expect(rtdbWriteLeaseStarter({ name: 'get', instance: INSTANCE, path: '/rooms' })).toBeUndefined();
    expect(rtdbWriteLeaseStarter({ name: 'Query.get', instance: INSTANCE, path: '/rooms' })).toBeUndefined();

    const startPatch = rtdbWriteLeaseStarter({
      name: 'update',
      instance: INSTANCE,
      path: '/rooms',
      patchArg: { 'r1/title': 'Next' },
    })!;
    const patchLease = startPatch();
    try {
      expect(inFlightRtdbOverlapOf(INSTANCE, '/rooms/r1/title')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/rooms/r2/title')).toEqual({ kind: 'none' });
    } finally {
      patchLease.release();
    }

    const startAdminPush = rtdbWriteLeaseStarter({
      name: 'Reference.push',
      instance: INSTANCE,
      path: '/messages',
      adminPushChildPath: '/messages/-Admin1',
    })!;
    const adminPushLease = startAdminPush();
    try {
      expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/-Admin1')).toEqual({ kind: 'covered' });
      expect(inFlightRtdbOverlapOf(INSTANCE, '/messages/other')).toEqual({ kind: 'none' });
    } finally {
      adminPushLease.release();
    }
  });
});
