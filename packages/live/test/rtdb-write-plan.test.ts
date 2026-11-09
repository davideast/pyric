/**
 * 1:1 unit tests for `rtdb-write-plan.ts`: pure, stateless RTDB write-target
 * path normalization, multi-path `update` subpath extraction, and client/Admin
 * write-target planning.
 */
import { describe, expect, test } from 'bun:test';
import {
  joinRtdbSubpath,
  normalizeInFlightRtdbPath,
  patchWritePathsOf,
  planRtdbWritePaths,
} from '../src/rtdb-write-plan.js';

const INSTANCE = 'demo-project-default-rtdb';

describe('rtdb-write-plan', () => {
  test('normalizes RTDB paths, joins subpaths, and extracts target subpaths from multi-path update patches', () => {
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

  test('computes pure target-path plans for client and Admin write methods and returns undefined for reads', () => {
    expect(planRtdbWritePaths({ name: 'get', instance: INSTANCE, path: '/rooms' })).toBeUndefined();
    expect(planRtdbWritePaths({ name: 'Query.get', instance: INSTANCE, path: '/rooms' })).toBeUndefined();

    expect(
      planRtdbWritePaths({
        name: 'set',
        instance: INSTANCE,
        path: 'rooms/r1/',
      }),
    ).toEqual({
      instance: INSTANCE,
      paths: ['/rooms/r1'],
    });

    expect(
      planRtdbWritePaths({
        name: 'update',
        instance: INSTANCE,
        path: '/rooms',
        patchArg: { 'r1/title': 'Next' },
      }),
    ).toEqual({
      instance: INSTANCE,
      paths: ['/rooms/r1/title'],
    });

    const resolvePush = (returned: unknown) => (typeof returned === 'string' ? returned : undefined);
    expect(
      planRtdbWritePaths({
        name: 'push',
        instance: INSTANCE,
        path: '/messages',
        resolveClientPushPath: resolvePush,
      }),
    ).toEqual({
      instance: INSTANCE,
      paths: ['/messages'],
      resolveNarrowedPath: resolvePush,
    });

    expect(
      planRtdbWritePaths({
        name: 'Reference.push',
        instance: INSTANCE,
        path: '/messages',
        adminPushChildPath: '/messages/-Admin1',
      }),
    ).toEqual({
      instance: INSTANCE,
      paths: ['/messages/-Admin1'],
    });
  });
});
