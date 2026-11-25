import { describe, expect, it } from 'bun:test';
import { Timestamp as UpstreamTimestamp } from 'firebase-admin/firestore';
import { Timestamp } from '../../src/firestore/index.js';

describe('pyric-admin/firestore Timestamp Temporal.Instant helpers', () => {
  it('converts positive and negative epoch instants identically to firebase-admin/firestore', () => {
    const samples = [
      0n,
      1_795_582_800_123_456_789n,
      -1n,
      -1_000_000_000n,
      -1_000_000_001n,
      -500_000_000n,
    ];
    for (const epochNanoseconds of samples) {
      const mirror = Timestamp.fromInstant({ epochNanoseconds });
      const upstream = UpstreamTimestamp.fromInstant({
        epochNanoseconds,
        epochMilliseconds: Number(epochNanoseconds / 1_000_000n),
        toString: () => String(epochNanoseconds),
      });
      expect(mirror.seconds).toBe(upstream.seconds);
      expect(mirror.nanoseconds).toBe(upstream.nanoseconds);
    }
  });

  it('rejects malformed instant inputs with the upstream error message', () => {
    let mirrorErr: Error | undefined;
    let upstreamErr: Error | undefined;
    try {
      Timestamp.fromInstant({} as unknown as { readonly epochNanoseconds: bigint });
    } catch (error) {
      mirrorErr = error as Error;
    }
    try {
      UpstreamTimestamp.fromInstant({} as unknown as Parameters<typeof UpstreamTimestamp.fromInstant>[0]);
    } catch (error) {
      upstreamErr = error as Error;
    }
    expect(mirrorErr?.message).toBe(upstreamErr?.message);
  });

  it('returns a typed Temporal.Instant shape from toInstant() and throws when Temporal is absent', () => {
    const globalRef = globalThis as { Temporal?: unknown };
    const previousTemporal = globalRef.Temporal;
    try {
      delete globalRef.Temporal;
      const sample = new Timestamp(1_795_582_800, 123_456_789);
      let missingErr: Error | undefined;
      let upstreamMissingErr: Error | undefined;
      try {
        sample.toInstant();
      } catch (error) {
        missingErr = error as Error;
      }
      try {
        new UpstreamTimestamp(1_795_582_800, 123_456_789).toInstant();
      } catch (error) {
        upstreamMissingErr = error as Error;
      }
      expect(missingErr?.message).toBe(upstreamMissingErr?.message);

      globalRef.Temporal = {
        Instant: {
          fromEpochNanoseconds(epochNanoseconds: bigint) {
            return {
              epochMilliseconds: Number(epochNanoseconds / 1_000_000n),
              epochNanoseconds,
              toString: () => `Instant(${String(epochNanoseconds)})`,
            };
          },
        },
      };
      const instant = sample.toInstant();
      const nanos: bigint = instant.epochNanoseconds;
      const millis: number = instant.epochMilliseconds;
      const text: string = instant.toString();
      expect(nanos).toBe(1_795_582_800_123_456_789n);
      expect(millis).toBe(1_795_582_800_123);
      expect(text).toBe('Instant(1795582800123456789)');
      expect(Timestamp.fromInstant(instant).isEqual(sample)).toBe(true);
    } finally {
      if (previousTemporal === undefined) {
        delete globalRef.Temporal;
      } else {
        globalRef.Temporal = previousTemporal;
      }
    }
  });
});
