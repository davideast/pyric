import { describe, expect, it } from "bun:test";
import type { ToolHandler } from "pyric/sandbox/internal";
import { createAssuranceTools } from "../../src/assurance/index.js";
import {
  redactCampaignExport,
  resultError,
  targetSchema,
} from "../../src/assurance/tools-schemas.js";
import { AssuranceInputError } from "../../src/assurance/types.js";

function tool(tools: ToolHandler[], name: string): ToolHandler {
  const match = tools.find((item) => item.name === name);
  if (!match) throw new Error(`missing tool ${name}`);
  return match;
}

describe("tools-schemas and AuthFixtureUser round-trip", () => {
  it("declares all optional AuthFixtureUser fields concisely in targetSchema", () => {
    const userProps = targetSchema.properties.state.properties.auth.properties
      .users.items.properties as Record<string, unknown>;
    expect(Object.keys(userProps).sort()).toEqual([
      "customClaims",
      "disabled",
      "displayName",
      "email",
      "emailVerified",
      "password",
      "phoneNumber",
      "photoUrl",
      "providerId",
      "providerUserInfo",
      "tenantId",
      "uid",
    ]);
  });

  it("exposes multi-bucket Storage, storageConfig, auth.providers, and rich Storage metadata in targetSchema and preserves auth.providers on export", () => {
    const rulesProps = targetSchema.properties.rules.properties as Record<
      string,
      unknown
    >;
    const stateProps = targetSchema.properties.state.properties as Record<
      string,
      unknown
    >;
    const authProps = targetSchema.properties.state.properties.auth
      .properties as Record<string, unknown>;
    const storageItemProps = targetSchema.properties.state.properties.storage
      .items.properties as Record<string, unknown>;

    expect(rulesProps.storageBuckets).toBeDefined();
    expect(stateProps.storageBuckets).toBeDefined();
    expect(stateProps.storageConfig).toBeDefined();
    expect(authProps.providers).toBeDefined();
    expect(Object.keys(storageItemProps).sort()).toEqual([
      "cacheControl",
      "contentDisposition",
      "contentEncoding",
      "contentLanguage",
      "contentType",
      "customMetadata",
      "dataBase64",
      "path",
      "timeCreated",
      "updated",
    ]);

    const redacted = redactCampaignExport({
      schema: "pyric.assurance.export.v1",
      campaign: {
        schema: "pyric.assurance.campaign.v1",
        id: "c-providers",
        target: {
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {},
          state: {
            auth: {
              users: [{ uid: "u-1", password: "secret-password" }],
              providers: { anonymous: false },
            },
          },
        },
        actors: [],
        invariants: [],
        probes: [],
      },
      observations: [],
      cases: [],
    });
    expect(redacted.campaign.target.state.auth).toEqual({
      users: [{ uid: "u-1" }],
      providers: { anonymous: false },
    });
  });

  it("formats AssuranceInputError codes and redacts passwords while preserving AuthFixtureUser metadata", () => {
    const inputErr = resultError(new AssuranceInputError("invalid target"));
    expect(inputErr).toEqual({
      ok: false,
      summary: "invalid target",
      data: { code: "ASSURANCE_INVALID_INPUT" },
    });

    const plainErr = resultError(new Error("boom"));
    expect(plainErr).toEqual({ ok: false, summary: "boom" });

    const redacted = redactCampaignExport({
      campaign: {
        schema: "pyric.assurance.campaign.v1",
        id: "c-1",
        target: {
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {},
          state: {
            auth: {
              users: [
                {
                  uid: "u-1",
                  email: "u1@example.test",
                  password: "top-secret-password",
                  displayName: "User One",
                  photoUrl: "https://example.test/u1.png",
                  phoneNumber: "+15550100101",
                  tenantId: "tenant-acme",
                  providerId: "password",
                  emailVerified: true,
                  disabled: false,
                  customClaims: { tier: "pro" },
                },
              ],
            },
          },
        },
        actors: [
          {
            id: "a-1",
            acquisition: {
              kind: "password",
              email: "u1@example.test",
              password: "top-secret-password",
            },
          },
        ],
        observations: [],
        invariants: [],
        probes: [],
      },
      cases: [],
      verifications: [],
    });

    expect(JSON.stringify(redacted)).not.toContain("top-secret-password");
    expect(redacted.campaign.target.state.auth?.users[0]).toEqual({
      uid: "u-1",
      email: "u1@example.test",
      displayName: "User One",
      photoUrl: "https://example.test/u1.png",
      phoneNumber: "+15550100101",
      tenantId: "tenant-acme",
      providerId: "password",
      emailVerified: true,
      disabled: false,
      customClaims: { tier: "pro" },
    });
  });

  it("round-trips optional AuthFixtureUser fields through inline firebase_assurance_start execution and export", async () => {
    const tools = createAssuranceTools();
    const started = await tool(tools, "firebase_assurance_start").execute({
      campaignId: "auth-fixture-fields-campaign",
      target: {
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {
          firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{id} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == 'tenant-acme'
        && request.auth.token.tier == 'pro'
        && request.auth.token.email_verified == true;
    }
    match /guestItems/{id} {
      allow read: if request.auth != null
        && request.auth.token.firebase.sign_in_provider == 'anonymous';
    }
  }
}`,
        },
        state: {
          firestore: {
            "orgs/acme/items/i1": { ownerId: "u-owner", locked: true },
            "guestItems/g1": { label: "welcome" },
          },
          auth: {
            users: [
              {
                uid: "u-owner",
                email: "owner@example.test",
                password: "secret-password",
                displayName: "Owner User",
                photoUrl: "https://example.test/avatar.png",
                phoneNumber: "+15550100101",
                tenantId: "tenant-acme",
                providerId: "password",
                emailVerified: true,
                disabled: false,
                customClaims: { tier: "pro" },
              },
              {
                uid: "u-anon",
                email: null,
                providerId: "anonymous",
              },
            ],
          },
        },
      },
    });
    expect(started).toMatchObject({ ok: true });

    await tool(tools, "firebase_assurance_map").execute({
      campaignId: "auth-fixture-fields-campaign",
      actors: [
        { id: "owner", acquisition: { kind: "fixture-user", uid: "u-owner" } },
        { id: "anon", acquisition: { kind: "fixture-user", uid: "u-anon" } },
      ],
      observations: [
        {
          id: "owner-reads-item",
          actorId: "owner",
          result: "ALLOW",
          source: "authored",
          operation: {
            service: "firestore",
            method: "get",
            path: "orgs/acme/items/i1",
          },
        },
        {
          id: "anon-reads-guest",
          actorId: "anon",
          result: "ALLOW",
          source: "authored",
          operation: {
            service: "firestore",
            method: "get",
            path: "guestItems/g1",
          },
        },
      ],
    });
    await tool(tools, "firebase_assurance_define").execute({
      campaignId: "auth-fixture-fields-campaign",
      invariants: [
        {
          id: "guest-cannot-read-tenant-item",
          service: "firestore",
          statement: "Anonymous guest cannot read tenant item.",
          expected: "DENY",
          source: "declared",
          confidence: "authoritative",
        },
      ],
    });
    await tool(tools, "firebase_assurance_propose").execute({
      campaignId: "auth-fixture-fields-campaign",
      observationId: "anon-reads-guest",
      invariantId: "guest-cannot-read-tenant-item",
      mutations: [
        {
          id: "anon-reads-tenant-item",
          dimension: "path",
          description: "Read tenant item instead of guest item.",
          operation: {
            service: "firestore",
            method: "get",
            path: "orgs/acme/items/i1",
          },
        },
      ],
    });

    const runResult = await tool(tools, "firebase_assurance_run").execute({
      campaignId: "auth-fixture-fields-campaign",
    });
    expect(runResult).toMatchObject({
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
      campaignId: "auth-fixture-fields-campaign",
    });
    expect(exported).toMatchObject({
      ok: true,
      data: {
        campaign: {
          target: {
            state: {
              auth: {
                users: [
                  {
                    uid: "u-owner",
                    email: "owner@example.test",
                    displayName: "Owner User",
                    photoUrl: "https://example.test/avatar.png",
                    phoneNumber: "+15550100101",
                    tenantId: "tenant-acme",
                    providerId: "password",
                    emailVerified: true,
                    disabled: false,
                    customClaims: { tier: "pro" },
                  },
                  {
                    uid: "u-anon",
                    email: null,
                    providerId: "anonymous",
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(exported)).not.toContain("secret-password");
  });
});
