import { describe, expect, it } from 'bun:test';
import {
  registeredActivityValue,
  trustedWireActivityValue,
} from '../../../src/firestore/sandbox/activity-value-registry.js';
import {
  DOC_VALUE_ENCODING,
  decodeDocValue,
  rehydrateDocValue,
  rehydrateEncodedDocValue,
} from '../../../src/firestore/internal/value-codec.js';
import { Bytes } from '@pyric/rules/internal';
import { Duration } from '@pyric/rules/internal';
import { LatLng } from '@pyric/rules/internal';
import { Path } from '@pyric/rules/internal';
import { Reference } from '@pyric/rules/internal';
import { Timestamp } from '@pyric/rules/internal';
import { Vector } from '@pyric/rules/internal';

describe('rehydrateDocValue', () => {
  it('rehydrates every Pyric marker into its wrapper type', () => {
    const cases: Array<[unknown, new (...args: never[]) => object]> = [
      [{ __type: 'timestamp', seconds: 12, nanos: 34 }, Timestamp],
      [{ __type: 'bytes', base64: 'aGVsbG8' }, Bytes],
      [{ __type: 'latlng', lat: 37.7, lng: -122.4 }, LatLng],
      [{ __type: 'duration', seconds: 5, nanos: 6 }, Duration],
      [{ __type: 'reference', path: 'users/alice' }, Reference],
      [{ __type: 'path', segments: ['users', 'alice'] }, Path],
      [{ __type__: '__vector__', value: [0.1, 0.2] }, Vector],
    ];

    for (const [marker, Wrapper] of cases) {
      expect(rehydrateDocValue(marker)).toBeInstanceOf(Wrapper);
    }
  });

  it('rehydrates Firebase SDK JSON markers', () => {
    const timestamp = rehydrateDocValue({
      type: 'firestore/timestamp/1.0', seconds: 12, nanoseconds: 34,
    });
    const bytes = rehydrateDocValue({ type: 'firestore/bytes/1.0', bytes: 'aGVsbG8=' });
    const geoPoint = rehydrateDocValue({
      type: 'firestore/geoPoint/1.0', latitude: 37.7, longitude: -122.4,
    });

    expect(timestamp).toBeInstanceOf(Timestamp);
    expect((timestamp as Timestamp).nanos).toBe(34);
    expect(bytes).toBeInstanceOf(Bytes);
    expect(new TextDecoder().decode((bytes as Bytes).data)).toBe('hello');
    expect(geoPoint).toBeInstanceOf(LatLng);
    expect((geoPoint as LatLng).lat).toBe(37.7);
  });

  it('registers a bounded activity identity only for the hydrated root', () => {
    const marker = {
      nested: { __type: 'timestamp', seconds: 12, nanos: 34 },
      values: [1, 2, 3],
    };
    const hydrated = rehydrateDocValue(marker) as {
      nested: Timestamp;
      values: number[];
    };

    expect(registeredActivityValue(hydrated)).toEqual(trustedWireActivityValue(marker));
    expect(registeredActivityValue(hydrated.nested)).toBeUndefined();
    expect(registeredActivityValue(hydrated.values)).toBeUndefined();
  });

  it('passes unknown markers through while recursively hydrating their values', () => {
    const hydrated = rehydrateDocValue({
      __type: 'future',
      nested: { __type: 'reference', path: 'users/alice' },
    }) as Record<string, unknown>;

    expect(hydrated.__type).toBe('future');
    expect(hydrated.nested).toBeInstanceOf(Reference);
  });

  it('preserves named databaseId across rehydrateDocValue, rehydrateEncodedDocValue, and decodeDocValue', () => {
    const namedMarker = { __type: 'reference', path: 'orgs/o1', databaseId: 'tenant-db' };
    const qualifiedMarker = { __type: 'reference', path: 'databases/analytics-db/documents/docs/d1' };
    const defaultMarker = { __type: 'reference', path: 'users/u1' };

    const hydratedNamed = rehydrateDocValue(namedMarker) as Reference;
    expect(hydratedNamed).toBeInstanceOf(Reference);
    expect(hydratedNamed.path).toBe('orgs/o1');
    expect(hydratedNamed.databaseId).toBe('tenant-db');

    const hydratedEncoded = rehydrateEncodedDocValue(
      { namedMarker, qualifiedMarker, defaultMarker },
      DOC_VALUE_ENCODING,
    ) as {
      namedMarker: Reference;
      qualifiedMarker: Reference;
      defaultMarker: Reference;
    };
    expect(hydratedEncoded.namedMarker.databaseId).toBe('tenant-db');
    expect(hydratedEncoded.qualifiedMarker.path).toBe('docs/d1');
    expect(hydratedEncoded.qualifiedMarker.databaseId).toBe('analytics-db');
    expect(hydratedEncoded.defaultMarker.databaseId).toBe('(default)');

    const decodedCalls: Array<{ path: string; databaseId?: string }> = [];
    decodeDocValue(
      { namedMarker, qualifiedMarker, defaultMarker },
      {
        create: (path, databaseId) => {
          decodedCalls.push({ path, databaseId });
          return { path, databaseId };
        },
      },
      DOC_VALUE_ENCODING,
    );
    expect(decodedCalls).toEqual([
      { path: 'orgs/o1', databaseId: 'tenant-db' },
      { path: 'docs/d1', databaseId: 'analytics-db' },
      { path: 'users/u1', databaseId: undefined },
    ]);
  });
});
