import { describe, expect, it } from "bun:test";
import { qualifyProbe } from "../../src/assurance/capabilities.js";
import type {
  AssuranceProbe,
  LocalFirebaseTarget,
} from "../../src/assurance/types.js";

const targetBase = {
  schema: "pyric.assurance.target.v1",
  network: "forbid",
  state: {},
} as const;

describe("Issue 8: RTDB Assurance capability qualification (AST over regex & supported features)", () => {
  it("does not falsely flag string literals or property accesses containing 'data', 'newData', or 'query'", () => {
    const target: LocalFirebaseTarget = {
      ...targetBase,
      rules: {
        rtdb: {
          rules: {
            rooms: {
              $roomId: {
                // None of these reference the built-in `data`, `newData`, or `query` identifiers:
                // they are string literals ("data", "newData", "query") or token properties (auth.token.data).
                ".read":
                  'auth != null && auth.token.scope != "query" && auth.token.query == true',
                ".write":
                  'auth != null && auth.token.role != "data" && auth.token.mode != "newData" && auth.token.data == true',
              },
            },
          },
        },
      },
    };

    const probe: AssuranceProbe = {
      id: "rtdb-string-literal-false-positive",
      actorId: "member",
      invariantId: "boundary",
      control: {
        service: "rtdb",
        method: "set",
        path: "/rooms/r1",
        data: "Control",
      },
      mutation: {
        dimension: "payload",
        description: "Mutate payload.",
        operation: {
          service: "rtdb",
          method: "get",
          path: "/rooms/r1",
        },
      },
    };

    const qualification = qualifyProbe(target, probe);
    expect(qualification.supported).toBe(true);
  });

  it("qualifies RTDB rules that use data/newData at the operation's own rule location (non-ancestor)", () => {
    const target: LocalFirebaseTarget = {
      ...targetBase,
      rules: {
        rtdb: {
          rules: {
            profiles: {
              $uid: {
                ".read": 'auth != null && data.child("owner").val() == auth.uid',
                ".write":
                  'auth != null && newData.child("owner").val() == data.child("owner").val()',
              },
            },
          },
        },
      },
    };

    const probe: AssuranceProbe = {
      id: "rtdb-supported-semantics",
      actorId: "alice",
      invariantId: "boundary",
      control: {
        service: "rtdb",
        method: "set",
        path: "/profiles/alice",
        data: { name: "Alicia", owner: "alice" },
      },
      mutation: {
        dimension: "payload",
        description: "Attempt to overwrite owner at the rule location.",
        operation: {
          service: "rtdb",
          method: "set",
          path: "/profiles/alice",
          data: { name: "Alicia", owner: "mallory" },
        },
      },
    };

    const qualification = qualifyProbe(target, probe);
    expect(qualification.supported).toBe(true);
  });
});
