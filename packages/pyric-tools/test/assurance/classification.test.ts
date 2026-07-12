import { describe, expect, it } from "bun:test";
import {
  ASSURANCE_ENGINE_CAPABILITIES,
  AssuranceInputError,
  runAuthorizationCampaign,
  type AuthorizationCampaignSpec,
} from "../../src/assurance/index.js";

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
    const weakNode = ASSURANCE_ENGINE_CAPABILITIES.flatMap(
      (capability) => capability.dependencies,
    ).find(
      (dependency) =>
        (dependency.kind === "construct" || dependency.kind === "registry-row") &&
        dependency.verdict !== "supported",
    );
    if (!weakNode || (weakNode.kind !== "construct" && weakNode.kind !== "registry-row")) {
      throw new Error("expected a non-supported graph node");
    }

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
});
