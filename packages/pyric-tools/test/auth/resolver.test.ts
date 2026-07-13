import { expect, test, describe, afterEach } from "bun:test";
import { getAuthTools } from "../../src/auth/resolver.js";
import type { ProjectScope } from '../../src/credentials/core/types.js';

const SCOPE: ProjectScope = {
  projectId: "test-project",
  resolveToken: async () => "fake-token",
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  (global as any).fetch = async (url: string | URL) => handler(url.toString());
}

describe("getAuthTools (admin resolver)", () => {
  test("returns enabled providers and settings", async () => {
    mockFetch((url) => {
      if (url.endsWith("/v2/projects/test-project/defaultSupportedIdpConfigs")) {
        return new Response(JSON.stringify({
          defaultSupportedIdpConfigs: [
            { name: "projects/test-project/defaultSupportedIdpConfigs/google.com", enabled: true },
            { name: "projects/test-project/defaultSupportedIdpConfigs/facebook.com", enabled: false },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/v2/projects/test-project/config")) {
        return new Response(JSON.stringify({
          signIn: { email: { enabled: true }, anonymous: {} },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL fetched: ${url}`);
    });

    const analyzer = getAuthTools(SCOPE);
    const result = await analyzer.generateIR();

    expect(result.service).toBe("authentication");
    expect(result.enabledProviders).toEqual(["google.com", "password"]);
    expect(result.settings.allowPasswordSignup).toBe(true);
    expect(result.settings.enableAnonymousUser).toBe(false);
  });

  test("throws error on non-200 idp response", async () => {
    mockFetch((url) => {
      if (url.endsWith("/v2/projects/test-project/defaultSupportedIdpConfigs")) {
        return new Response(null, { status: 403, statusText: "Forbidden" });
      }
      return new Response(JSON.stringify({
        signIn: { email: { enabled: true }, anonymous: {} },
      }), { status: 200 });
    });

    const analyzer = getAuthTools(SCOPE);
    await expect(analyzer.generateIR()).rejects.toThrow("Failed to fetch IDPs: Forbidden");
  });

  test("throws error on non-200 config response", async () => {
    mockFetch((url) => {
      if (url.endsWith("/v2/projects/test-project/defaultSupportedIdpConfigs")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(null, { status: 500, statusText: "Internal Server Error" });
    });

    const analyzer = getAuthTools(SCOPE);
    await expect(analyzer.generateIR()).rejects.toThrow("Failed to fetch config: Internal Server Error");
  });
});
