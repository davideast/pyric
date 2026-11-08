import { describe, expect, test } from "bun:test";
import { GeoPoint, Timestamp } from "pyric/firestore";
import { bundleRecords, serializeToBuckets } from "pyric/sandbox";
import { decodeLiveStatePayload } from "../../src/assurance/derive-live-state.js";
import { AssuranceInputError } from "../../src/assurance/types.js";

describe("derive-live-state", () => {
  test("decodes pyric-v3-records bundles across Firestore databases, RTDB priorities/instances, and Auth users", () => {
    const records = serializeToBuckets(
      {
        "users/u-alice/items/item-1": {
          title: "First",
          updatedAt: Timestamp.fromMillis(1_700_000_500_000),
          coords: new GeoPoint(37.77, -122.41),
        },
        "/databases/analytics/documents/events/ev-1": {
          count: 7,
        },
      },
      {
        rtdb: {
          ".pyricRtdbPersistence": 1,
          data: { scores: { u1: 99 } },
          priorities: { "scores/u1": 1 },
          instances: {
            "telemetry-shard": {
              ".pyricRtdbPersistence": 1,
              data: { pings: { p1: true } },
              priorities: {},
              rules: { rules: { pings: { ".read": true } } },
            },
          },
        },
        auth: {
          users: [
            {
              uid: "u-alice",
              email: "alice@example.test",
              customClaims: { tier: "pro" },
            },
          ],
          providers: {},
        },
      },
      1_700_000_500_000,
    );

    const decoded = decodeLiveStatePayload({
      version: 1,
      firestore: JSON.parse(bundleRecords(records)),
      auth: null,
    });

    expect(
      decoded.firestoreByDb["(default)"]?.["users/u-alice/items/item-1"]?.title,
    ).toBe("First");
    expect(
      decoded.firestoreByDb["(default)"]?.["users/u-alice/items/item-1"]
        ?.coords,
    ).toEqual({
      type: "firestore/geoPoint/1.0",
      latitude: 37.77,
      longitude: -122.41,
    });
    expect(decoded.firestoreByDb.analytics?.["events/ev-1"]).toEqual({
      count: 7,
    });
    expect(decoded.rtdbByInstance["(default)"]).toEqual({
      scores: {
        u1: {
          ".value": 99,
          ".priority": 1,
        },
      },
    });
    expect(decoded.rtdbByInstance["telemetry-shard"]).toEqual({
      pings: { p1: true },
    });
    expect(decoded.rtdbInstanceRules["telemetry-shard"]).toEqual({
      rules: { pings: { ".read": true } },
    });
    expect(decoded.snapshotUsers.map((u) => u.uid)).toEqual(["u-alice"]);
  });

  test("throws AssuranceInputError on corrupt pyric-v3-records bundle", () => {
    expect(() =>
      decodeLiveStatePayload({
        version: 1,
        firestore: { format: "pyric-v3-records", records: {} },
        auth: null,
      }),
    ).toThrow(AssuranceInputError);
  });
});
