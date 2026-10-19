import { describe, expect, it } from "bun:test";
import {
  AssuranceInputError,
  runAuthorizationCampaign,
  type AuthorizationCampaignSpec,
} from "../../src/assurance/index.js";
import { CONFORMANCE_VERDICTS } from "../../src/assurance/.generated/conformance-verdicts.js";

const OPEN_FIRESTORE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if true; }
  }
}`;

function firestoreCampaign(): AuthorizationCampaignSpec {
  return {
    schema: "pyric.assurance.campaign.v1",
    id: "classification-firestore",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: { firestore: OPEN_FIRESTORE },
      state: { firestore: { "rooms/r1": { ownerId: "alice", title: "Room" } } },
    },
    actors: [
      {
        id: "synthetic-member",
        acquisition: { kind: "synthetic", uid: "mallory" },
      },
    ],
    invariants: [
      {
        id: "owner-boundary",
        service: "firestore",
        statement: "A member must not transfer room ownership.",
        expected: "DENY",
        source: "agent",
        confidence: "tentative",
      },
    ],
    probes: [
      {
        id: "owner-transfer",
        actorId: "synthetic-member",
        invariantId: "owner-boundary",
        control: {
          service: "firestore",
          method: "update",
          path: "rooms/r1",
          data: { title: "Edited" },
        },
        mutation: {
          dimension: "payload",
          description: "Change ownerId instead of title.",
          operation: {
            service: "firestore",
            method: "update",
            path: "rooms/r1",
            data: { ownerId: "mallory" },
          },
        },
      },
    ],
  };
}

describe("campaign classification integrity", () => {
  it("keeps a permissive result from a synthetic identity as a candidate signal", async () => {
    const report = await runAuthorizationCampaign(firestoreCampaign());

    expect(report.results[0]).toMatchObject({
      actorEvidence: { reachability: "synthetic", uid: "mallory" },
      classification: "candidate-signal",
      control: { decision: "ALLOW" },
      mutation: { decision: "ALLOW" },
    });
    expect(report.summary).toMatchObject({
      localCounterexamples: 0,
      candidateSignals: 1,
    });
  });

  it("keeps agent-inferred tentative intent as a candidate even for a reachable password actor", async () => {
    const campaign = firestoreCampaign();
    campaign.target.state.auth = {
      users: [
        {
          uid: "mallory",
          email: "mallory@example.test",
          password: "password-123",
        },
      ],
    };
    campaign.actors = [
      {
        id: "synthetic-member",
        acquisition: {
          kind: "password",
          email: "mallory@example.test",
          password: "password-123",
        },
      },
    ];

    const report = await runAuthorizationCampaign(campaign);

    expect(report.results[0]).toMatchObject({
      actorEvidence: { reachability: "reachable", uid: "mallory" },
      classification: "candidate-signal",
    });
  });

  it("reuses one reachable anonymous identity across isolated control and mutation sandboxes", async () => {
    const campaign = firestoreCampaign();
    campaign.invariants[0]!.confidence = "authoritative";
    campaign.invariants[0]!.source = "declared";
    campaign.actors = [
      { id: "synthetic-member", acquisition: { kind: "anonymous-account" } },
    ];

    const report = await runAuthorizationCampaign(campaign);
    const result = report.results[0]!;
    const controlAuth = result.control.events.find((event) => event.auth)
      ?.auth as { uid?: string } | undefined;
    const mutationAuth = result.mutation.events.find((event) => event.auth)
      ?.auth as { uid?: string } | undefined;

    expect(result.actorEvidence).toMatchObject({
      acquisition: "anonymous-account",
      reachability: "reachable",
    });
    expect(controlAuth?.uid).toBe(result.actorEvidence.uid);
    expect(mutationAuth?.uid).toBe(result.actorEvidence.uid);
    expect(result.classification).toBe("local-counterexample");
  });

  it("reports an RTDB data/newData dependency as an engine gap without executing it", async () => {
    const campaign: AuthorizationCampaignSpec = {
      schema: "pyric.assurance.campaign.v1",
      id: "rtdb-fidelity-gate",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          rtdb: {
            rules: {
              profiles: {
                $uid: {
                  ".write":
                    'auth != null && newData.child("owner").val() == data.child("owner").val()',
                },
              },
            },
          },
        },
        state: {
          rtdb: { profiles: { alice: { owner: "alice", name: "Alice" } } },
        },
      },
      actors: [
        { id: "alice", acquisition: { kind: "synthetic", uid: "alice" } },
      ],
      invariants: [
        {
          id: "owner-immutable",
          service: "rtdb",
          statement: "A profile owner field must not change.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "owner-change",
          actorId: "alice",
          invariantId: "owner-immutable",
          control: {
            service: "rtdb",
            method: "set",
            path: "/profiles/alice/name",
            data: "Alicia",
          },
          mutation: {
            dimension: "path",
            description: "Change the owner field instead of the display name.",
            operation: {
              service: "rtdb",
              method: "set",
              path: "/profiles/alice/owner",
              data: "Alicia",
            },
          },
        },
      ],
    };

    const report = await runAuthorizationCampaign(campaign);

    expect(report.results[0]).toMatchObject({
      classification: "engine-gap",
      control: { decision: "UNSUPPORTED", events: [] },
      mutation: { decision: "UNSUPPORTED", events: [] },
      qualification: { supported: false },
    });
    expect(report.results[0]?.qualification.requirements).toContainEqual(
      expect.objectContaining({
        id: "rtdb.rule-location-data",
        supported: false,
      }),
    );
  });

  it("abstains — never reports no-counterexample — when a probe requires a graph node the graph does not derive as supported", async () => {
    // The probe below would otherwise EXECUTE and, against these permissive
    // rules, come back clean. It must not: it requires a graph node the
    // conformance graph does not derive as `supported`, so the engine cannot
    // treat its own verdict as evidence. Silence from a simulator that cannot
    // see the behavior is not evidence of safety.
    const weakEntry = Object.entries(CONFORMANCE_VERDICTS).find(([, verdict]) => verdict !== "supported");
    if (!weakEntry) {
      throw new Error("expected a non-supported graph node");
    }
    const weakNode = {
      id: weakEntry[0],
      verdict: weakEntry[1],
      kind: weakEntry[0].includes("#") ? "registry-row" as const : "construct" as const,
    };

    const campaign = firestoreCampaign();
    campaign.probes[0]!.requires = [{ kind: weakNode.kind, id: weakNode.id }];

    const report = await runAuthorizationCampaign(campaign);

    expect(report.results[0]).toMatchObject({
      classification: "engine-gap",
      control: { decision: "UNSUPPORTED", events: [] },
      mutation: { decision: "UNSUPPORTED", events: [] },
      qualification: { supported: false },
    });
    expect(report.summary.engineGaps).toBe(1);
    expect(report.summary.noCounterexamples).toBe(0);

    // The abstention cites the node's derived verdict.
    const requirement = report.results[0]?.qualification.requirements.find(
      (item) => item.id === weakNode.id,
    );
    expect(requirement?.supported).toBe(false);
    expect(requirement?.reason).toContain(weakNode.verdict);
  });

  it("rejects any target that does not explicitly forbid networking", async () => {
    const campaign = firestoreCampaign();
    (campaign.target as { network: string }).network = "allow";

    await expect(runAuthorizationCampaign(campaign)).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceInputError>>({
        code: "ASSURANCE_INVALID_INPUT",
      }),
    );
  });

  it("classifies empty list reads and no-op Storage writes as candidate-signal rather than local-counterexample (AV-RUN-6)", async () => {
    const report = await runAuthorizationCampaign({
      schema: "pyric.assurance.campaign.v1",
      id: "av-run-6-impact",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow read, write: if true; }
    match /secrets/{docId} { allow read, write: if true; }
  }
}`,
          storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`,
        },
        state: {
          auth: { users: [{ uid: "alice", email: "alice@example.com" }] },
          firestore: { "rooms/r1": { owner: "alice" } },
          storage: [
            {
              path: "files/alice.txt",
              dataBase64: Buffer.from("same-content", "utf8").toString("base64"),
              contentType: "text/plain",
              customMetadata: { owner: "alice" },
            },
          ],
        },
      },
      actors: [{ id: "alice", acquisition: { kind: "fixture-user", uid: "alice" } }],
      invariants: [
        {
          id: "fs-inv",
          service: "firestore",
          statement: "Secrets must not be listed.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
        {
          id: "st-inv",
          service: "storage",
          statement: "Private prefix and files must not be accessed.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
      probes: [
        {
          id: "empty-firestore-list",
          actorId: "alice",
          invariantId: "fs-inv",
          control: { service: "firestore", method: "list", path: "rooms" },
          mutation: {
            dimension: "path",
            description: "List empty secrets collection.",
            operation: { service: "firestore", method: "list", path: "secrets" },
          },
        },
        {
          id: "empty-storage-list",
          actorId: "alice",
          invariantId: "st-inv",
          control: { service: "storage", method: "list", path: "files" },
          mutation: {
            dimension: "path",
            description: "List empty private prefix.",
            operation: { service: "storage", method: "list", path: "private" },
          },
        },
        {
          id: "noop-storage-write",
          actorId: "alice",
          invariantId: "st-inv",
          control: {
            service: "storage",
            method: "updateMetadata",
            path: "files/alice.txt",
            contentType: "text/plain",
            customMetadata: { owner: "alice", tag: "v1" },
          },
          mutation: {
            dimension: "payload",
            description: "No-op updateMetadata with identical metadata as fixture.",
            operation: {
              service: "storage",
              method: "updateMetadata",
              path: "files/alice.txt",
              contentType: "text/plain",
              customMetadata: { owner: "alice" },
            },
          },
        },
      ],
    });

    expect(report.results.map((r) => r.classification)).toEqual([
      "candidate-signal",
      "candidate-signal",
      "candidate-signal",
    ]);
    expect(report.summary.localCounterexamples).toBe(0);
    expect(report.summary.candidateSignals).toBe(3);
  });
});
