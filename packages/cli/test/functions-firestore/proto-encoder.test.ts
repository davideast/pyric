import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  Bytes as RulesBytes,
  LatLng as RulesLatLng,
  Reference as RulesReference,
  Timestamp as RulesTimestamp,
  Vector as RulesVector,
} from 'pyric/rules/internal';
import {
  FirestoreReferenceValue,
  encodeFirestoreDocumentEventData,
} from '../../src/functions/firestore/proto-encoder.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const protos = requireFromConformance(
  './node_modules/firebase-functions/protos/compiledFirestore.js',
) as {
  google: {
    events: {
      cloud: {
        firestore: {
          v1: {
            DocumentEventData: {
              decode(buf: Uint8Array): {
                value?: {
                  name: string;
                  fields: Record<string, Record<string, unknown> & { valueType: string }>;
                  createTime?: { seconds: { toNumber(): number }; nanos: number };
                  updateTime?: { seconds: { toNumber(): number }; nanos: number };
                };
                oldValue?: {
                  name: string;
                  fields: Record<string, Record<string, unknown> & { valueType: string }>;
                };
                updateMask?: { fieldPaths: string[] };
              };
            };
          };
        };
      };
    };
  };
};

const DocumentEventData = protos.google.events.cloud.firestore.v1.DocumentEventData;

describe('encodeFirestoreDocumentEventData', () => {
  test('encodes all Firestore scalar, wrapper, array, map, vector, oldValue, and updateMask wire types', () => {
    const encoded = encodeFirestoreDocumentEventData(
      {
        value: {
          name: 'projects/demo-project/databases/(default)/documents/users/alice',
          fields: {
            nil: null,
            flagTrue: true,
            flagFalse: false,
            zeroInt: 0,
            posInt: 123456789,
            negInt: -9876543210,
            negZero: -0,
            pi: 3.14159,
            nanVal: Number.NaN,
            posInf: Number.POSITIVE_INFINITY,
            negInf: Number.NEGATIVE_INFINITY,
            emptyStr: '',
            greeting: 'hello world',
            rawBytes: Buffer.from([1, 2, 3, 255]),
            rulesBytes: new RulesBytes(new Uint8Array([9, 8, 7])),
            rulesTs: new RulesTimestamp(1_700_000_000, 123_456_789),
            jsDate: new Date('2026-07-13T20:00:00.250Z'),
            rulesGeo: new RulesLatLng(37.7749, -122.4194),
            rulesRef: new RulesReference('orders/ord-1'),
            wireRef: new FirestoreReferenceValue('profiles/alice', 'analytics'),
            rulesVec: new RulesVector([0.25, -0.5, 1.0]),
            items: ['a', 2, false, null],
            nestedMap: { inner: 'ok', count: 5 },
            plainLookalike: { seconds: 10, nanoseconds: 20 },
          },
          createTime: { seconds: 1_700_000_000, nanos: 100 },
          updateTime: { seconds: 1_700_000_005, nanos: 200 },
        },
        oldValue: {
          name: 'projects/demo-project/databases/(default)/documents/users/alice',
          fields: { greeting: 'previous' },
          createTime: { seconds: 1_700_000_000, nanos: 100 },
          updateTime: { seconds: 1_700_000_000, nanos: 100 },
        },
        updateMask: ['greeting', 'nestedMap.count'],
      },
      {
        projectId: 'demo-project',
        database: '(default)',
      },
    );

    const decoded = DocumentEventData.decode(encoded);
    expect(decoded.value?.name).toBe(
      'projects/demo-project/databases/(default)/documents/users/alice',
    );
    expect(decoded.value?.createTime?.seconds.toNumber()).toBe(1_700_000_000);
    expect(decoded.value?.createTime?.nanos).toBe(100);
    expect(decoded.value?.updateTime?.seconds.toNumber()).toBe(1_700_000_005);
    expect(decoded.value?.updateTime?.nanos).toBe(200);

    const fields = decoded.value?.fields ?? {};
    expect(fields.nil?.valueType).toBe('nullValue');
    expect(fields.flagTrue?.booleanValue).toBe(true);
    expect(fields.flagFalse?.valueType).toBe('booleanValue');
    expect(fields.flagFalse?.booleanValue).toBe(false);
    expect((fields.zeroInt?.integerValue as { toNumber(): number }).toNumber()).toBe(0);
    expect((fields.posInt?.integerValue as { toNumber(): number }).toNumber()).toBe(
      123456789,
    );
    expect((fields.negInt?.integerValue as { toNumber(): number }).toNumber()).toBe(
      -9876543210,
    );
    expect(fields.negZero?.valueType).toBe('doubleValue');
    expect(Object.is(fields.negZero?.doubleValue, -0)).toBe(true);
    expect(fields.pi?.doubleValue).toBeCloseTo(3.14159, 5);
    expect(Number.isNaN(fields.nanVal?.doubleValue)).toBe(true);
    expect(fields.posInf?.doubleValue).toBe(Number.POSITIVE_INFINITY);
    expect(fields.negInf?.doubleValue).toBe(Number.NEGATIVE_INFINITY);
    expect(fields.emptyStr?.valueType).toBe('stringValue');
    expect(fields.emptyStr?.stringValue).toBe('');
    expect(fields.greeting?.stringValue).toBe('hello world');
    expect(Buffer.from(fields.rawBytes?.bytesValue as Uint8Array)).toEqual(
      Buffer.from([1, 2, 3, 255]),
    );
    expect(Buffer.from(fields.rulesBytes?.bytesValue as Uint8Array)).toEqual(
      Buffer.from([9, 8, 7]),
    );

    const ts = fields.rulesTs?.timestampValue as {
      seconds: { toNumber(): number };
      nanos: number;
    };
    expect(ts.seconds.toNumber()).toBe(1_700_000_000);
    expect(ts.nanos).toBe(123_456_789);

    const geo = fields.rulesGeo?.geoPointValue as { latitude: number; longitude: number };
    expect(geo.latitude).toBeCloseTo(37.7749, 4);
    expect(geo.longitude).toBeCloseTo(-122.4194, 4);

    expect(fields.rulesRef?.referenceValue).toBe(
      'projects/demo-project/databases/(default)/documents/orders/ord-1',
    );
    expect(fields.wireRef?.referenceValue).toBe(
      'projects/demo-project/databases/analytics/documents/profiles/alice',
    );
    expect(fields.plainLookalike?.valueType).toBe('mapValue');
    expect(decoded.oldValue?.fields.greeting?.stringValue).toBe('previous');
    expect(decoded.updateMask?.fieldPaths).toEqual(['greeting', 'nestedMap.count']);
  });
});
