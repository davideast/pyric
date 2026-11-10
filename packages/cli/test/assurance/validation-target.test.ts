import { describe, expect, it } from "bun:test";
import { assertTarget } from "../../src/assurance/validation-target.js";

function rejectionOf(call: () => void): string {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  return "";
}

describe("validation-target", () => {
  it("accepts all optional AuthFixtureUser fields including anonymous email: null accounts", () => {
    expect(() =>
      assertTarget({
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {},
        state: {
          auth: {
            users: [
              {
                uid: "u-1",
                email: "u1@example.test",
                password: "password-123",
                displayName: "User One",
                photoUrl: "https://example.test/u1.png",
                phoneNumber: "+15550100101",
                tenantId: "tenant-1",
                providerId: "password",
                emailVerified: true,
                disabled: false,
                customClaims: { role: "member" },
              },
              {
                uid: "u-anon",
                email: null,
                providerId: "anonymous",
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects malformed optional AuthFixtureUser and StorageObjectFixture fields with exact positions", () => {
    const malformedUsers: Array<[Record<string, unknown>, string]> = [
      [{ uid: "u-bad", email: 42 }, "target.state.auth.users[0].email"],
      [{ uid: "u-bad", displayName: 123 }, "target.state.auth.users[0].displayName"],
      [{ uid: "u-bad", photoUrl: false }, "target.state.auth.users[0].photoUrl"],
      [{ uid: "u-bad", phoneNumber: {} }, "target.state.auth.users[0].phoneNumber"],
      [{ uid: "u-bad", tenantId: 99 }, "target.state.auth.users[0].tenantId"],
      [{ uid: "u-bad", providerId: [] }, "target.state.auth.users[0].providerId"],
      [{ uid: "u-bad", emailVerified: "yes" }, "target.state.auth.users[0].emailVerified"],
      [{ uid: "u-bad", disabled: 0 }, "target.state.auth.users[0].disabled"],
      [{ uid: "u-bad", customClaims: "admin" }, "target.state.auth.users[0].customClaims"],
    ];

    for (const [badUser, expectedPosition] of malformedUsers) {
      const message = rejectionOf(() =>
        assertTarget({
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {},
          state: { auth: { users: [badUser] } },
        }),
      );
      expect(message).toContain(expectedPosition);
    }

    const storageMetaMessage = rejectionOf(() =>
      assertTarget({
        schema: "pyric.assurance.target.v1",
        network: "forbid",
        rules: {},
        state: {
          storage: [
            {
              path: "files/u1/item.txt",
              dataBase64: "aGVsbG8=",
              customMetadata: { tier: 123 },
            },
          ],
        },
      }),
    );
    expect(storageMetaMessage).toContain(
      "target.state.storage[0].customMetadata",
    );

    expect(
      rejectionOf(() =>
        assertTarget({
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: { storageBuckets: { "bucket-a": 123 } },
          state: {},
        }),
      ),
    ).toContain('target.rules.storageBuckets["bucket-a"]');

    expect(
      rejectionOf(() =>
        assertTarget({
          schema: "pyric.assurance.target.v1",
          network: "forbid",
          rules: {},
          state: {
            storageBuckets: {
              "bucket-a": [{ path: "files/f1", dataBase64: "***not-base64***" }],
            },
          },
        }),
      ),
    ).toContain('target.state.storageBuckets["bucket-a"][0].dataBase64');
  });
});
