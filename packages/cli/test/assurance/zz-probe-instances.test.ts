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
