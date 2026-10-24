import { test, expect } from "bun:test";
import { runAuthorizationCampaign } from "../../src/assurance/runner.js";

test("Assurance respects named RTDB instances", async () => {
  const spec: any = {
    schema: "pyric.assurance.campaign.v1",
    id: "test-rtdb-instances",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: { 
        rtdb: { rules: { ".read": "false", ".write": "false" } },
        rtdbInstances: {
          "my-named-instance": { rules: { ".read": "true", ".write": "true" } }
        }
      },
      state: {},
    },
    actors: [{ id: "actor1", acquisition: { kind: "anonymous-request" } }],
    invariants: [{
      id: "inv1", statement: "Test named instance", service: "rtdb", expected: "ALLOW", source: "authored-test", confidence: "authoritative"
    }],
    probes: [
      {
        id: "probe-default", actorId: "actor1", invariantId: "inv1",
        control: { service: "rtdb", method: "get", path: "/default-path" },
        mutation: { dimension: "path", description: "mut", operation: { service: "rtdb", method: "get", path: "/default-path-2" } },
      },
      {
        id: "probe-named", actorId: "actor1", invariantId: "inv1",
        control: {
          service: "rtdb", method: "get", path: "/named-path",
          instance: "https://my-named-instance.firebaseio.com",
        },
        mutation: {
          dimension: "path", description: "mut",
          operation: {
            service: "rtdb", method: "get", path: "/named-path-2",
            instance: "my-named-instance",
          },
        },
      },
    ],
  };

  const report = await runAuthorizationCampaign(spec);
  const defaultProbe = report.results.find((r: any) => r.probeId === "probe-default");
  const namedProbe = report.results.find((r: any) => r.probeId === "probe-named");
  
  // Default instance has .read: false, so it should be DENY
  expect(defaultProbe?.control.decision).toBe("DENY");
  
  // Named instance has .read: true, so it should be ALLOW
  expect(namedProbe?.control.decision).toBe("ALLOW"); 
  expect(namedProbe?.mutation.decision).toBe("ALLOW");
});

test("Assurance rejects operations with unknown fields", async () => {
  const spec: any = {
    schema: "pyric.assurance.campaign.v1",
    id: "test-unknown-fields",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: { rtdb: { rules: { ".read": "false", ".write": "false" } } },
      state: {},
    },
    actors: [{ id: "actor1", acquisition: { kind: "anonymous-request" } }],
    invariants: [{
      id: "inv1", statement: "Test", service: "rtdb", expected: "ALLOW", source: "authored-test", confidence: "authoritative"
    }],
    probes: [
      {
        id: "probe-unknown", actorId: "actor1", invariantId: "inv1",
        control: { service: "rtdb", method: "get", path: "/default-path", fakeField: "bad" },
        mutation: { dimension: "path", description: "mut", operation: { service: "rtdb", method: "get", path: "/default-path-2" } },
      }
    ],
  };

  try {
    await runAuthorizationCampaign(spec);
    expect().fail("Should have thrown AssuranceInputError");
  } catch (e: any) {
    expect(e.name).toBe("AssuranceInputError");
    expect(e.message).toContain("operation names unknown field 'fakeField'");
  }
});

test("Assurance resolves instances regardless of URL/name format", async () => {
  const spec: any = {
    schema: "pyric.assurance.campaign.v1",
    id: "test-rtdb-instances-resolve",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: { 
        rtdbInstances: {
          "https://url-declared.firebaseio.com": { rules: { ".read": "true", ".write": "true" } },
          "name-declared": { rules: { ".read": "true", ".write": "true" } }
        }
      },
      state: {
        rtdbInstances: {
          "url-declared": { "key1": "val1" },
          "https://name-declared.firebaseio.com": { "key2": "val2" }
        }
      },
    },
    actors: [{ id: "actor1", acquisition: { kind: "anonymous-request" } }],
    invariants: [{
      id: "inv1", statement: "Test", service: "rtdb", expected: "ALLOW", source: "authored-test", confidence: "authoritative"
    }],
    probes: [
      {
        id: "probe-url-declared", actorId: "actor1", invariantId: "inv1",
        control: { service: "rtdb", method: "get", path: "/key1", instance: "url-declared" },
        mutation: { dimension: "path", description: "mut", operation: { service: "rtdb", method: "get", path: "/key2", instance: "url-declared" } },
      },
      {
        id: "probe-name-declared", actorId: "actor1", invariantId: "inv1",
        control: { service: "rtdb", method: "get", path: "/key2", instance: "https://name-declared.firebaseio.com" },
        mutation: { dimension: "path", description: "mut", operation: { service: "rtdb", method: "get", path: "/key1", instance: "https://name-declared.firebaseio.com" } },
      },
    ],
  };

  const report = await runAuthorizationCampaign(spec);
  expect(report.summary.invalidProbes).toBe(0);
  const urlProbe = report.results.find((r: any) => r.probeId === "probe-url-declared");
  const nameProbe = report.results.find((r: any) => r.probeId === "probe-name-declared");

  // Since data is matched by resolved name, /key1 is available in url-declared and /key2 in name-declared.
  expect(urlProbe?.control.output).toBe("val1");
  expect(nameProbe?.control.output).toBe("val2");
});

test("Assurance rejects duplicate spellings of the same instance in rules", async () => {
  const spec: any = {
    schema: "pyric.assurance.campaign.v1",
    id: "test-rtdb-instances-dupe-rules",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: { 
        rtdbInstances: {
          "shard-00": { rules: { ".read": "true" } },
          "https://shard-00.firebaseio.com": { rules: { ".read": "true" } }
        }
      },
      state: {},
    }
  };
  try {
    await runAuthorizationCampaign(spec);
    expect().fail("Should have thrown AssuranceInputError");
  } catch (e: any) {
    expect(e.name).toBe("AssuranceInputError");
    expect(e.message).toContain("declares instance 'shard-00' which is already declared");
  }
});

test("Assurance rejects state instances with no declared rules", async () => {
  const spec: any = {
    schema: "pyric.assurance.campaign.v1",
    id: "test-rtdb-instances-orphaned-state",
    target: {
      schema: "pyric.assurance.target.v1",
      network: "forbid",
      rules: {},
      state: {
        rtdbInstances: {
          "shard-00": { "key": "val" }
        }
      },
    }
  };
  try {
    await runAuthorizationCampaign(spec);
    expect().fail("Should have thrown AssuranceInputError");
  } catch (e: any) {
    expect(e.name).toBe("AssuranceInputError");
    expect(e.message).toContain("provides state for instance 'shard-00' which has no declared rules");
  }
});
