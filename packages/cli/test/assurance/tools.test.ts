import { describe, expect, it } from "bun:test";
import type { ToolHandler } from "@inbrowser/agent";
import {
  createAssuranceTools,
  type AssuranceVisualizationSnapshot,
} from "../../src/assurance/index.js";

function tool(tools: ToolHandler[], name: string): ToolHandler {
  const match = tools.find((item) => item.name === name);
  if (!match) throw new Error(`missing tool ${name}`);
  return match;
}

describe("createAssuranceTools", () => {
  it("publishes complete AI-facing schemas for targets, actors, invariants, and mutations", () => {
    const tools = createAssuranceTools();
    const startSchema = tool(tools, "firebase_assurance_start").parameters as {
      properties: { target: { properties: Record<string, unknown> } };
    };
    const mapSchema = tool(tools, "firebase_assurance_map").parameters as {
      properties: {
        actors: {
          items: { properties: { acquisition: { oneOf: unknown[] } } };
        };
      };
    };
    const defineSchema = tool(tools, "firebase_assurance_define")
      .parameters as {
      properties: {
        invariants: {
          items: { properties: { confidence: { enum: string[] } } };
        };
      };
    };
    const proposeSchema = tool(tools, "firebase_assurance_propose")
      .parameters as {
      properties: {
        mutations: {
          items: { properties: { dimension: { enum: string[] } } };
        };
      };
      required: string[];
    };

    expect(startSchema.properties.target.properties).toHaveProperty("rules");
    expect(
      mapSchema.properties.actors.items.properties.acquisition.oneOf,
    ).toHaveLength(5);
    expect(
      defineSchema.properties.invariants.items.properties.confidence.enum,
    ).toEqual(["authoritative", "strong", "tentative"]);
    expect(
      proposeSchema.properties.mutations.items.properties.dimension.enum,
    ).toEqual(["path", "query", "payload", "operation"]);
    expect(proposeSchema.required).toEqual([
      "campaignId",
      "observationId",
      "invariantId",
      "mutations",
    ]);
  });

  it("drives one resumable local campaign through the public agent workflow", async () => {
    const updates: AssuranceVisualizationSnapshot[] = [];
    const tools = createAssuranceTools({
      onCampaignUpdate: (snapshot) => updates.push(snapshot),
    });
    expect(tools.map((item) => item.name)).toEqual([
      "firebase_assurance_attach",
      "firebase_assurance_start",
      "firebase_assurance_map",
      "firebase_assurance_define",
      "firebase_assurance_propose",
      "firebase_assurance_run",
      "firebase_assurance_inspect",
      "firebase_assurance_minimize",
      "firebase_assurance_verify",
      "firebase_assurance_export",
    ]);

    const started = await tool(tools, "firebase_assurance_start").execute({
      campaignId: "tool-profile-campaign",
      target: {
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
            "profiles/alice": { displayName: "Alice", admin: false },
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
      },
    });
    expect(started).toMatchObject({
      ok: true,
      data: {
        campaignId: "tool-profile-campaign",
        localOnly: true,
        services: ["firestore"],
        // Statuses are DERIVED from the conformance graph, never authored.
        // `auth.password-anonymous-fixture` is `qualified` (not `supported`)
        // because registry row auth#7 documents an SDK-surface divergence, and
        // the capability carries that dependency as its structured evidence
        // (the abstention sentence is rendered on read via `capabilityReasons`).
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            id: "firestore.crud",
            status: "supported",
          }),
          expect.objectContaining({
            id: "auth.password-anonymous-fixture",
            status: "qualified",
            dependencies: expect.arrayContaining([
              expect.objectContaining({ id: "auth#7" }),
            ]),
          }),
        ]),
      },
    });
    expect(JSON.stringify(updates.at(-1))).not.toContain("password-123");
    expect(updates.at(-1)).not.toHaveProperty("target");

    const mapped = await tool(tools, "firebase_assurance_map").execute({
      campaignId: "tool-profile-campaign",
      actors: [
        {
          id: "alice-password",
          acquisition: {
            kind: "password",
            email: "alice@example.test",
            password: "password-123",
          },
        },
      ],
      observations: [
        {
          id: "display-name-control",
          actorId: "alice-password",
          result: "ALLOW",
          source: "captured",
          operation: {
            service: "firestore",
            method: "update",
            path: "profiles/alice",
            data: { displayName: "Alicia" },
          },
        },
      ],
    });
    expect(mapped).toMatchObject({
      ok: true,
      data: { actors: 1, observations: 1 },
    });

    await tool(tools, "firebase_assurance_define").execute({
      campaignId: "tool-profile-campaign",
      invariants: [
        {
          id: "admin-immutable",
          service: "firestore",
          statement: "A profile owner must not grant themselves admin.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
    });
    await tool(tools, "firebase_assurance_propose").execute({
      campaignId: "tool-profile-campaign",
      observationId: "display-name-control",
      invariantId: "admin-immutable",
      mutations: [
        {
          id: "admin-escalation",
          dimension: "payload",
          description: "Change admin instead of displayName.",
          operation: {
            service: "firestore",
            method: "update",
            path: "profiles/alice",
            data: { admin: true },
          },
        },
      ],
    });

    const run = await tool(tools, "firebase_assurance_run").execute({
      campaignId: "tool-profile-campaign",
    });
    expect(run).toMatchObject({
      ok: true,
      data: { summary: { controlsPassed: 1, localCounterexamples: 1 } },
    });

    const inspected = await tool(tools, "firebase_assurance_inspect").execute({
      campaignId: "tool-profile-campaign",
      probeId: "admin-escalation",
    });
    expect(inspected).toMatchObject({
      ok: true,
      data: {
        result: { classification: "local-counterexample" },
        visualization: {
          view: "assurance",
          campaignId: "tool-profile-campaign",
          probeId: "admin-escalation",
        },
      },
    });

    const verified = await tool(tools, "firebase_assurance_verify").execute({
      campaignId: "tool-profile-campaign",
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
    });
    expect(verified).toMatchObject({
      ok: true,
      data: {
        summary: {
          controlsPassed: 1,
          noCounterexamples: 1,
          localCounterexamples: 0,
        },
      },
    });

    const exported = await tool(tools, "firebase_assurance_export").execute({
      campaignId: "tool-profile-campaign",
    });
    expect(exported).toMatchObject({
      ok: true,
      data: {
        cases: [{ id: "admin-escalation", expect: "DENY" }],
        redactions: expect.arrayContaining([
          "campaign.target.state.auth.users[].password",
          "campaign.actors[].acquisition.password",
        ]),
        verifications: [
          expect.objectContaining({
            summary: expect.objectContaining({ noCounterexamples: 1 }),
          }),
        ],
      },
    });
    expect(JSON.stringify(exported)).not.toContain("password-123");
  });

  it("starts a campaign by attaching read-only to a running local Pyric instance", async () => {
    const updates: AssuranceVisualizationSnapshot[] = [];
    const target = {
      schema: "pyric.assurance.target.v1" as const,
      network: "forbid" as const,
      rules: {
        firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} { allow read: if request.auth != null; }
  }
}`,
      },
      state: {
        firestore: { "profiles/alice": { displayName: "Alice" } },
        auth: { users: [{ uid: "alice", email: "alice@example.test" }] },
      },
    };
    const tools = createAssuranceTools({
      onCampaignUpdate: (snapshot) => updates.push(snapshot),
      attachmentProvider: async ({ url }) => ({
        target,
        source: {
          requestedUrl: url,
          origin: "http://localhost:5210",
          transport: "same-origin-shared-worker",
          readOnly: true,
          studioUrl: "http://localhost:5210/__pyric/ui/assurance",
        },
        inventory: {
          firestoreDocuments: 1,
          rtdbPresent: false,
          authUsers: 1,
          storageObjects: 0,
        },
        coverageGaps: [
          {
            service: "storage",
            code: "storage-attachment-unavailable",
            reason: "Storage requires explicit fixtures.",
          },
        ],
      }),
    });

    const attached = await tool(tools, "firebase_assurance_attach").execute({
      campaignId: "attached-local-app",
      url: "http://localhost:5210/__pyric/ui/",
    });

    expect(attached).toMatchObject({
      ok: true,
      data: {
        campaignId: "attached-local-app",
        localOnly: true,
        source: {
          origin: "http://localhost:5210",
          readOnly: true,
        },
        inventory: { firestoreDocuments: 1 },
        services: ["firestore"],
        coverageGaps: [{ code: "storage-attachment-unavailable" }],
        suggestedActors: [
          {
            id: "candidate-alice",
            acquisition: { kind: "synthetic", uid: "alice" },
            reachability: "candidate-only",
          },
        ],
        visualization: {
          url: "http://localhost:5210/__pyric/ui/assurance?campaign=attached-local-app",
        },
      },
    });
    expect(updates.at(-1)).toMatchObject({
      campaignId: "attached-local-app",
      observations: [],
      probes: [],
      context: {
        attachment: {
          source: { origin: "http://localhost:5210", readOnly: true },
          inventory: { firestoreDocuments: 1 },
          coverageGaps: [{ code: "storage-attachment-unavailable" }],
        },
      },
    });
    expect(updates.at(-1)).not.toHaveProperty("target");
  });

  it("rejects a non-positive campaign run budget", async () => {
    const tools = createAssuranceTools();
    const started = await tool(tools, "firebase_assurance_start").execute({
      campaignId: "invalid-budget",
      maxRuns: 0,
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {},
        state: {},
      },
    });

    expect(started).toMatchObject({
      ok: false,
      summary: "campaign maxRuns must be a positive integer.",
      data: { code: "ASSURANCE_INVALID_INPUT" },
    });
  });
});
