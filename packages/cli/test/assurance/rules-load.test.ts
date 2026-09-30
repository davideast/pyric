import "fake-indexeddb/auto";

import { describe, expect, it } from "bun:test";
import {
  runAuthorizationCampaign,
  type AuthorizationCampaignSpec,
  type FirebaseOperation,
  type LocalFirebaseTarget,
} from "../../src/assurance/index.js";

/** A condition nested past production's expression depth, which production refuses to compile. */
const TOO_DEEP = `${"(".repeat(300)}request.auth != null${")".repeat(300)}`;

const FIRESTORE_PAST_LIMIT = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow read, update: if ${TOO_DEEP}; }
  }
}`;

const STORAGE_PAST_LIMIT = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /rooms/{allPaths=**} { allow read, write: if ${TOO_DEEP}; }
  }
}`;

const PRODUCTION_REFUSAL = "Line 4: Expression is too complex to evaluate safely.";

function campaign(
  rules: LocalFirebaseTarget["rules"],
  state: LocalFirebaseTarget["state"],
  control: FirebaseOperation,
  mutation: FirebaseOperation,
  dimension: "payload" | "path" = "payload",
): AuthorizationCampaignSpec {
  const service = control.service;
  return {
    schema: "pyric.assurance.campaign.v1",
    id: `refused-${service}`,
    target: { schema: "pyric.assurance.target.v1", network: "forbid", rules, state },
    actors: [{ id: "member", acquisition: { kind: "synthetic", uid: "mallory" } }],
    invariants: [
      {
        id: "owner-boundary",
        service,
        statement: "A member must not change another owner's record.",
        expected: "DENY",
        source: "declared",
        confidence: "authoritative",
      },
    ],
    probes: [
      {
        id: "owner-transfer",
        actorId: "member",
        invariantId: "owner-boundary",
        control,
        mutation: { dimension, description: "Change the owner.", operation: mutation },
      },
    ],
  };
}

describe("a candidate ruleset production refuses to compile", () => {
  it("reports Firestore rules as refused with production's message and runs no operation", async () => {
    const report = await runAuthorizationCampaign(
      campaign(
        { firestore: FIRESTORE_PAST_LIMIT },
        { firestore: { "rooms/r1": { ownerId: "alice", title: "Room" } } },
        { service: "firestore", method: "update", path: "rooms/r1", data: { title: "Edited" } },
        { service: "firestore", method: "update", path: "rooms/r1", data: { ownerId: "mallory" } },
      ),
    );
    const [result] = report.results;
    const refusal = { code: "rules-refused", message: `Firestore rules did not compile: ${PRODUCTION_REFUSAL}` };
    expect(result!.classification).toBe("invalid-probe");
    expect(result!.control).toMatchObject({ decision: "ERROR", error: refusal, events: [] });
    expect(result!.mutation).toMatchObject({ decision: "ERROR", error: refusal, events: [] });
    expect(result!.stateDiff).toBeUndefined();
    expect(result!.qualification.requirements).toContainEqual(
      expect.objectContaining({ id: "firestore.rules-load", supported: false, reason: refusal.message }),
    );
    expect(report.summary.invalidProbes).toBe(1);
  });

  it("reports Storage rules as refused with production's message and runs no operation", async () => {
    const upload = (path: string): FirebaseOperation => ({
      service: "storage",
      method: "upload",
      path,
      dataBase64: "bWFsbG9yeQ==",
      contentType: "text/plain",
    });
    const report = await runAuthorizationCampaign(
      campaign({ storage: STORAGE_PAST_LIMIT }, {}, upload("rooms/r1/mallory.txt"), upload("rooms/r1/alice.txt"), "path"),
    );
    const [result] = report.results;
    const refusal = { code: "rules-refused", message: `Storage rules did not compile: ${PRODUCTION_REFUSAL}` };
    expect(result!.classification).toBe("invalid-probe");
    expect(result!.control).toMatchObject({ decision: "ERROR", error: refusal, events: [] });
    expect(result!.mutation).toMatchObject({ decision: "ERROR", error: refusal, events: [] });
    expect(result!.qualification.requirements).toContainEqual(
      expect.objectContaining({ id: "storage.rules-load", supported: false, reason: refusal.message }),
    );
  });

  it("reports a source that does not parse as refused with the parse position", async () => {
    const report = await runAuthorizationCampaign(
      campaign(
        {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow read, update: if true }
  }
}`,
        },
        { firestore: { "rooms/r1": { ownerId: "alice" } } },
        { service: "firestore", method: "update", path: "rooms/r1", data: { title: "Edited" } },
        { service: "firestore", method: "update", path: "rooms/r1", data: { ownerId: "mallory" } },
      ),
    );
    const [result] = report.results;
    expect(result!.classification).toBe("invalid-probe");
    expect(result!.mutation.error).toEqual({
      code: "rules-refused",
      message: "Firestore rules did not parse at line 4, column 57: expected ';' after the allow statement.",
    });
  });
});
