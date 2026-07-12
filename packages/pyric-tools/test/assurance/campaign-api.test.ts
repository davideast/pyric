import { describe, expect, it } from "bun:test";
import {
  AssuranceInputError,
  createAuthorizationCampaign,
  runSecurityCases,
  type LocalFirebaseTarget,
} from "../../src/assurance/index.js";

const target: LocalFirebaseTarget = {
  schema: "pyric.assurance.target.v1",
  network: "forbid",
  rules: {
    firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} { allow update: if request.auth != null; }
  }
}`,
  },
  state: {
    firestore: {
      "profiles/alice": { displayName: "Alice", role: "user", admin: false },
    },
    auth: {
      users: [
        {
          uid: "alice",
          email: "alice@example.test",
          password: "password-123",
        },
      ],
    },
  },
};

describe("AuthorizationCampaign", () => {
  it("rejects malformed invariants before they can become strong findings", () => {
    const campaign = createAuthorizationCampaign({
      id: "invalid-invariant",
      target,
    });

    expect(() =>
      campaign.addInvariant({
        id: "typo-confidence",
        service: "firestore",
        statement: "A user must not grant themselves admin.",
        expected: "DENY",
        source: "agent",
        confidence: "tentativee",
      } as never),
    ).toThrow(
      "invariant 'typo-confidence' has invalid confidence 'tentativee'.",
    );
  });

  it("rejects a mutation that changes more than its declared dimension", () => {
    const campaign = createAuthorizationCampaign({
      id: "multi-dimensional-probe",
      target,
    });
    campaign.addActor({
      id: "alice-password",
      acquisition: {
        kind: "password",
        email: "alice@example.test",
        password: "password-123",
      },
    });
    campaign.addInvariant({
      id: "profile-boundary",
      service: "firestore",
      statement: "A user must not edit another profile.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });

    expect(() =>
      campaign.addProbe({
        id: "path-and-payload",
        actorId: "alice-password",
        invariantId: "profile-boundary",
        control: {
          service: "firestore",
          method: "update",
          path: "profiles/alice",
          data: { displayName: "Alicia" },
        },
        mutation: {
          dimension: "path",
          description: "Change the target profile.",
          operation: {
            service: "firestore",
            method: "update",
            path: "profiles/bob",
            data: { displayName: "Owned" },
          },
        },
      }),
    ).toThrow(
      "probe 'path-and-payload' declares a 'path' mutation but changes path, payload.",
    );
  });

  it("maps a known-good operation, proposes mutations, runs, inspects, and exports cases", async () => {
    const campaign = createAuthorizationCampaign({
      id: "profile-role-campaign",
      target,
      safety: { network: "forbid", maxRuns: 20 },
    });
    campaign.addActor({
      id: "alice-password",
      acquisition: {
        kind: "password",
        email: "alice@example.test",
        password: "password-123",
      },
    });
    campaign.addObservation({
      id: "profile-display-name-update",
      actorId: "alice-password",
      result: "ALLOW",
      source: "captured",
      operation: {
        service: "firestore",
        method: "update",
        path: "profiles/alice",
        data: { displayName: "Alicia" },
      },
    });
    campaign.addInvariant({
      id: "profile-role-immutable",
      service: "firestore",
      statement: "A user must not grant themselves an admin role.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });

    const [probe] = campaign.propose({
      observationId: "profile-display-name-update",
      invariantId: "profile-role-immutable",
      mutations: [
        {
          id: "profile-admin-escalation",
          dimension: "payload",
          description: "Change only admin and role fields.",
          operation: {
            service: "firestore",
            method: "update",
            path: "profiles/alice",
            data: { displayName: "Alicia", role: "admin", admin: true },
          },
        },
      ],
    });
    expect(probe?.id).toBe("profile-admin-escalation");

    const report = await campaign.run();
    expect(report.summary.localCounterexamples).toBe(1);
    expect(
      campaign.inspect("profile-admin-escalation").stateDiff,
    ).toMatchObject({
      changed: true,
      after: { displayName: "Alicia", role: "admin", admin: true },
    });

    const minimized = await campaign.minimize("profile-admin-escalation");
    expect(minimized.changed).toBe(true);
    expect(
      Object.keys(
        (
          minimized.probe.mutation.operation as {
            data: Record<string, unknown>;
          }
        ).data,
      ),
    ).toHaveLength(1);
    expect(minimized.result.classification).toBe("local-counterexample");

    const cases = campaign.exportSecurityCases();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      schema: "pyric.assurance.case.v1",
      id: "profile-admin-escalation",
      actorId: "alice-password",
      expect: "DENY",
      mutation: {
        dimension: "payload",
        operation: {
          service: "firestore",
          method: "update",
          path: "profiles/alice",
        },
      },
    });
    expect(campaign.export()).toMatchObject({
      schema: "pyric.assurance.export.v1",
      campaign: { id: "profile-role-campaign" },
      observations: [{ id: "profile-display-name-update" }],
      cases: [{ id: "profile-admin-escalation" }],
    });

    const fixedTarget: LocalFirebaseTarget = {
      ...target,
      rules: {
        firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} {
      allow update: if request.auth != null
        && request.resource.data.admin == resource.data.admin;
    }
  }
}`,
      },
    };
    const verification = await runSecurityCases({
      campaignId: "profile-role-fixed",
      target: fixedTarget,
      actors: campaign.spec().actors,
      cases,
    });
    expect(verification.results[0]).toMatchObject({
      control: { decision: "ALLOW" },
      mutation: { decision: "DENY" },
      classification: "no-counterexample",
    });
  });

  it("enforces the run budget during counterexample minimization", async () => {
    const campaign = createAuthorizationCampaign({
      id: "profile-budget-campaign",
      target,
      safety: { network: "forbid", maxRuns: 1 },
    });
    campaign.addActor({
      id: "alice-password",
      acquisition: {
        kind: "password",
        email: "alice@example.test",
        password: "password-123",
      },
    });
    campaign.addInvariant({
      id: "profile-role-immutable",
      service: "firestore",
      statement: "A user must not grant themselves an admin role.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    campaign.addProbe({
      id: "profile-admin-escalation",
      actorId: "alice-password",
      invariantId: "profile-role-immutable",
      control: {
        service: "firestore",
        method: "update",
        path: "profiles/alice",
        data: { displayName: "Alicia" },
      },
      mutation: {
        dimension: "payload",
        description: "Change admin and role.",
        operation: {
          service: "firestore",
          method: "update",
          path: "profiles/alice",
          data: { role: "admin", admin: true },
        },
      },
    });

    await campaign.run();

    await expect(campaign.minimize("profile-admin-escalation")).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceInputError>>({
        code: "ASSURANCE_INVALID_INPUT",
      }),
    );
  });

  it("never minimizes away the payload delta that gives a probe its meaning", async () => {
    const campaign = createAuthorizationCampaign({
      id: "profile-semantic-minimization",
      target,
      safety: { network: "forbid", maxRuns: 10 },
    });
    campaign.addActor({
      id: "alice-password",
      acquisition: {
        kind: "password",
        email: "alice@example.test",
        password: "password-123",
      },
    });
    campaign.addInvariant({
      id: "profile-admin-immutable",
      service: "firestore",
      statement: "A user must not grant themselves admin.",
      expected: "DENY",
      source: "declared",
      confidence: "authoritative",
    });
    campaign.addProbe({
      id: "profile-admin-escalation",
      actorId: "alice-password",
      invariantId: "profile-admin-immutable",
      control: {
        service: "firestore",
        method: "update",
        path: "profiles/alice",
        data: { displayName: "Alicia" },
      },
      mutation: {
        dimension: "payload",
        description:
          "Add admin while retaining the known-good display-name update.",
        operation: {
          service: "firestore",
          method: "update",
          path: "profiles/alice",
          data: { admin: true, displayName: "Alicia" },
        },
      },
    });

    await campaign.run();
    const minimized = await campaign.minimize("profile-admin-escalation");
    const data = (
      minimized.probe.mutation.operation as {
        data: Record<string, unknown>;
      }
    ).data;

    expect(data).toEqual({ admin: true });
    expect(minimized.removedPayloadFields).toEqual(["displayName"]);
  });
});
