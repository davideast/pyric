import { describe, expect, it } from "bun:test";
import { initializeSandbox } from "pyric/sandbox";
import { dispatchSandboxTool } from "../../src/bridge/client/dispatch.js";

describe("sandbox assurance dispatch", () => {
  it("keeps campaign state across separate in-page bridge tool calls", async () => {
    const sandbox = initializeSandbox();
    const started = await dispatchSandboxTool(
      sandbox,
      "firebase_assurance_start",
      {
        campaignId: "in-page-persistent-campaign",
        target: {
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {
            firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{uid} { allow read: if true; }
  }
}`,
          },
          state: { firestore: {} },
        },
      },
    );
    expect(started.ok).toBe(true);

    const defined = await dispatchSandboxTool(
      sandbox,
      "firebase_assurance_define",
      {
        campaignId: "in-page-persistent-campaign",
        invariants: [
          {
            id: "private-profile",
            service: "firestore",
            statement: "Profiles must not be public.",
            expected: "DENY",
            source: "declared",
            confidence: "authoritative",
          },
        ],
      },
    );

    expect(defined).toMatchObject({ ok: true, data: { invariants: 1 } });
  });
});
