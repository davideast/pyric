import { describe, it } from 'bun:test';
import {
  replayQueryDocumentIdAndNestedFieldPath,
  replayScalarBytesGeoPointVectorRoundTrip,
  replaySentinelTypeMismatchOverwrite,
  replayTimestampRoundTripAndNegativeMillis,
} from '../../../../conformance/src/firestore-sentinels-scalars-replay.ts';
import { expectReplay, inPageContext, load } from './support.ts';

describe('Firestore Sentinels and Scalar types oracle captures (in-page pyric/firestore)', () => {
  it('firestore-timestamp-roundtrip-and-negative-millis (firestore#104, #104a, #104b)', async () => {
    const production = load('firestore-timestamp-roundtrip-and-negative-millis');
    const ctx = inPageContext();
    try {
      const pyric = await replayTimestampRoundTripAndNegativeMillis(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-sentinel-type-mismatch-overwrite (firestore#105a)', async () => {
    const production = load('firestore-sentinel-type-mismatch-overwrite');
    const ctx = inPageContext();
    try {
      const pyric = await replaySentinelTypeMismatchOverwrite(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-scalar-bytes-geopoint-vector-roundtrip (firestore#106, #111)', async () => {
    const production = load('firestore-scalar-bytes-geopoint-vector-roundtrip');
    const ctx = inPageContext();
    try {
      const pyric = await replayScalarBytesGeoPointVectorRoundTrip(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });

  it('firestore-query-documentid-and-nested-fieldpath (firestore#107, #108)', async () => {
    const production = load('firestore-query-documentid-and-nested-fieldpath');
    const ctx = inPageContext();
    try {
      const pyric = await replayQueryDocumentIdAndNestedFieldPath(ctx);
      expectReplay({ production, pyric });
    } finally {
      ctx.dispose();
    }
  });
});
