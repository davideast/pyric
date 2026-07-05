import { describe, expect, test } from "bun:test";
import { AuthMapper } from "../../src/auth/mapper.js";
import { AuthIRGenerationError } from "../../src/auth/types.js";

describe("AuthMapper", () => {
  test("mapToIR maps valid idp and config data correctly", () => {
    const idpData = {
      defaultSupportedIdpConfigs: [
        { name: "projects/123/defaultSupportedIdpConfigs/google.com", enabled: true },
        { name: "projects/123/defaultSupportedIdpConfigs/github.com", enabled: false }
      ]
    };
    const configData = {
      signIn: {
        email: { enabled: true },
        anonymous: { enabled: true }
      }
    };

    const expectedIR = {
      service: "authentication" as const,
      enabledProviders: ["google.com" as const, "password" as const, "anonymous" as const],
      settings: {
        allowPasswordSignup: true,
        enableAnonymousUser: true
      }
    };

    expect(AuthMapper.mapToIR(idpData, configData)).toEqual(expectedIR);
  });

  test("mapToIR treats anonymous:{} (API shape for disabled) as not enabled", () => {
    const idpData = { defaultSupportedIdpConfigs: [] };
    const configData = { signIn: { anonymous: {} } };
    const result = AuthMapper.mapToIR(idpData, configData);
    expect(result.settings.enableAnonymousUser).toBe(false);
  });

  test("mapToIR throws AuthIRGenerationError when idpData is null or invalid", () => {
    const configData = {
      signIn: {
        email: { enabled: true },
        anonymous: {}
      }
    };
    expect(() => AuthMapper.mapToIR(null, configData)).toThrow(AuthIRGenerationError);
    expect(() => AuthMapper.mapToIR("invalid", configData)).toThrow(AuthIRGenerationError);
  });

  test("mapToIR throws AuthIRGenerationError when configData is null or invalid", () => {
    const idpData = {
      defaultSupportedIdpConfigs: []
    };
    expect(() => AuthMapper.mapToIR(idpData, null)).toThrow(AuthIRGenerationError);
    expect(() => AuthMapper.mapToIR(idpData, "invalid")).toThrow(AuthIRGenerationError);
  });

  test("mapToIR throws AuthIRGenerationError when an idp config is missing a name", () => {
    const idpData = {
      defaultSupportedIdpConfigs: [
        { enabled: true } // missing name
      ]
    };
    const configData = {
      signIn: {
        email: { enabled: true },
        anonymous: {}
      }
    };
    expect(() => AuthMapper.mapToIR(idpData, configData)).toThrow(AuthIRGenerationError);
  });

  test("mapToIR throws AuthIRGenerationError when configData is missing signIn", () => {
    const idpData = {
      defaultSupportedIdpConfigs: []
    };
    const configData = {
      // missing signIn
    };
    expect(() => AuthMapper.mapToIR(idpData, configData)).toThrow(AuthIRGenerationError);
  });

  test("mapToIR treats anonymous:{} (API shape for disabled) as not enabled", () => {
    const idpData = { defaultSupportedIdpConfigs: [] };
    const configData = { signIn: { anonymous: {} } };
    const result = AuthMapper.mapToIR(idpData, configData);
    expect(result.settings.enableAnonymousUser).toBe(false);
  });

  test("mapToIR handles empty valid data gracefully", () => {
    const idpData = {
      defaultSupportedIdpConfigs: []
    };
    const configData = {
      signIn: {}
    };

    const expectedIR = {
      service: "authentication" as const,
      enabledProviders: [],
      settings: {
        allowPasswordSignup: false,
        enableAnonymousUser: false
      }
    };

    expect(AuthMapper.mapToIR(idpData, configData)).toEqual(expectedIR);
  });
});
