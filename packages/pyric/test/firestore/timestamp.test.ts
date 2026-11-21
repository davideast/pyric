import { describe, expect, it } from 'bun:test';
import { FirebaseError as UpstreamFirebaseError } from 'firebase/app';
import { Timestamp as UpstreamTimestamp } from 'firebase/firestore';
import { FirebaseError } from 'pyric/app';
import { FirestoreError, Timestamp } from 'pyric/firestore';

describe('Timestamp.fromJSON (#1972)', () => {
  it('round-trips Timestamp.toJSON() across positive, epoch, and negative timestamps matching firebase/firestore@12.19.0', () => {
    const samples: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1_700_000_000, 123_456_789],
      [-62_135_596_800, 999_999_999],
      [-500, 500_000],
    ];
    for (const [seconds, nanoseconds] of samples) {
      const pyTs = new Timestamp(seconds, nanoseconds);
      const upTs = new UpstreamTimestamp(seconds, nanoseconds);
      expect(pyTs.toJSON()).toEqual(upTs.toJSON());

      const pyRoundTrip = Timestamp.fromJSON(pyTs.toJSON());
      const upRoundTrip = UpstreamTimestamp.fromJSON(upTs.toJSON());
      expect(pyRoundTrip).toBeInstanceOf(Timestamp);
      expect(pyRoundTrip.isEqual(pyTs)).toBe(true);
      expect(pyRoundTrip.seconds).toBe(upRoundTrip.seconds);
      expect(pyRoundTrip.nanoseconds).toBe(upRoundTrip.nanoseconds);
    }
  });

  it('rejects malformed Timestamp JSON payloads with FirebaseError(invalid-argument) matching firebase/firestore@12.19.0', () => {
    const invalidCases: readonly unknown[] = [
      null,
      undefined,
      'not-an-object',
      [],
      {},
      { type: 'wrong/type/1.0', seconds: 10, nanoseconds: 0 },
      { type: 'firestore/timestamp/1.0', nanoseconds: 0 },
      { type: 'firestore/timestamp/1.0', seconds: '10', nanoseconds: 0 },
      { type: 'firestore/timestamp/1.0', seconds: 10, nanoseconds: '0' },
      { type: 'firestore/timestamp/1.0', seconds: 10, nanoseconds: -1 },
      { type: 'firestore/timestamp/1.0', seconds: 10, nanoseconds: 1_000_000_000 },
    ];

    for (const candidate of invalidCases) {
      let upErr: unknown;
      let pyErr: unknown;
      try {
        UpstreamTimestamp.fromJSON(candidate as object);
      } catch (error) {
        upErr = error;
      }
      try {
        Timestamp.fromJSON(candidate as object);
      } catch (error) {
        pyErr = error;
      }
      expect(upErr).toBeInstanceOf(UpstreamFirebaseError);
      expect(pyErr).toBeInstanceOf(FirebaseError);
      expect(pyErr).not.toBeInstanceOf(FirestoreError);
      expect((pyErr as FirebaseError).code).toBe('invalid-argument');
      expect((pyErr as FirebaseError).message).toBe((upErr as UpstreamFirebaseError).message);
    }
  });
});
