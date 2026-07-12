import { describe, expect, it } from "bun:test";
import {
  ASSURANCE_ENGINE_CAPABILITIES,
  qualifyProbe,
} from "../../src/assurance/capabilities.js";
import type {
  AssuranceProbe,
  CapabilityDependency,
  LocalFirebaseTarget,
} from "../../src/assurance/types.js";

const targetBase = {
  schema: "pyric.assurance.target.v1",
  network: "forbid",
  state: {},
} as const;

const firestoreProbe: AssuranceProbe = {
  id: "firestore-update",
  actorId: "member",
  invariantId: "boundary",
  control: {
    service: "firestore",
    method: "update",
    path: "rooms/public",
    data: { title: "Control" },
  },
  mutation: {
    dimension: "payload",
    description: "Change ownerId.",
    operation: {
      service: "firestore",
      method: "update",
      path: "rooms/public",
      data: { ownerId: "member" },
    },
  },
};

function firestoreTarget(rules: string): LocalFirebaseTarget {
  return { ...targetBase, rules: { firestore: rules } };
}

describe("qualifyProbe", () => {
  it("rejects malformed Firestore rules before sandbox execution", () => {
    const qualification = qualifyProbe(
      firestoreTarget(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if request.auth != ; }
  }
}`),
      firestoreProbe,
    );

    expect(qualification.supported).toBe(false);
    expect(qualification.requirements).toContainEqual(
      expect.objectContaining({
        id: "firestore.rules-parse",
        supported: false,
      }),
    );
  });

  it("rejects rules whose result depends on overlapping Firestore match blocks", () => {
    const qualification = qualifyProbe(
      firestoreTarget(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if false; }
    match /rooms/public { allow update: if true; }
  }
}`),
      firestoreProbe,
    );

    expect(qualification.supported).toBe(false);
    expect(qualification.requirements).toContainEqual(
      expect.objectContaining({
        id: "firestore.match-resolution",
        supported: false,
      }),
    );
  });

  it("accepts multiple non-overlapping Firestore match blocks", () => {
    const qualification = qualifyProbe(
      firestoreTarget(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if true; }
    match /profiles/{uid} { allow update: if true; }
  }
}`),
      firestoreProbe,
    );

    expect(qualification.supported).toBe(true);
  });

  it("rejects malformed RTDB rule expressions before sandbox execution", () => {
    const target: LocalFirebaseTarget = {
      ...targetBase,
      rules: {
        rtdb: {
          rules: {
            rooms: {
              $roomId: { ".write": "auth != null &&&& root.exists()" },
            },
          },
        },
      },
    };
    const probe: AssuranceProbe = {
      id: "rtdb-write",
      actorId: "member",
      invariantId: "boundary",
      control: {
        service: "rtdb",
        method: "set",
        path: "/rooms/r1/title",
        data: "Control",
      },
      mutation: {
        dimension: "path",
        description: "Change owner.",
        operation: {
          service: "rtdb",
          method: "set",
          path: "/rooms/r1/owner",
          data: "member",
        },
      },
    };

    const qualification = qualifyProbe(target, probe);

    expect(qualification.supported).toBe(false);
    expect(qualification.requirements).toContainEqual(
      expect.objectContaining({ id: "rtdb.rules-parse", supported: false }),
    );
  });

  it("rejects RTDB rules that authorize from query constraints the sandbox cannot expose", () => {
    const target: LocalFirebaseTarget = {
      ...targetBase,
      rules: {
        rtdb: {
          rules: {
            rooms: {
              ".read": 'auth != null && query.orderByChild == "owner"',
            },
          },
        },
      },
    };
    const probe: AssuranceProbe = {
      id: "rtdb-query",
      actorId: "member",
      invariantId: "boundary",
      control: {
        service: "rtdb",
        method: "get",
        path: "/rooms",
        query: {
          orderBy: { kind: "child", path: "owner" },
          equalTo: { value: "member" },
        },
      },
      mutation: {
        dimension: "query",
        description: "Remove the owner equality constraint.",
        operation: {
          service: "rtdb",
          method: "get",
          path: "/rooms",
          query: { orderBy: { kind: "child", path: "owner" } },
        },
      },
    };

    const qualification = qualifyProbe(target, probe);

    expect(qualification.supported).toBe(false);
    expect(qualification.requirements).toContainEqual(
      expect.objectContaining({ id: "rtdb.query-rules", supported: false }),
    );
  });

  it("qualifies RTDB fidelity from rules relevant to the probed path only", () => {
    const target: LocalFirebaseTarget = {
      ...targetBase,
      rules: {
        rtdb: {
          rules: {
            rooms: {
              $roomId: {
                title: { ".write": "auth != null" },
              },
            },
            unrelated: {
              ".write": 'newData.child("owner").val() == auth.uid',
            },
          },
        },
      },
    };
    const probe: AssuranceProbe = {
      id: "rtdb-title",
      actorId: "member",
      invariantId: "boundary",
      control: {
        service: "rtdb",
        method: "set",
        path: "/rooms/r1/title",
        data: "Control",
      },
      mutation: {
        dimension: "payload",
        description: "Change title value.",
        operation: {
          service: "rtdb",
          method: "set",
          path: "/rooms/r1/title",
          data: "Mutation",
        },
      },
    };

    expect(qualifyProbe(target, probe).supported).toBe(true);
  });
});

/**
 * The forward contract: a probe names graph nodes (constructs, registry rows)
 * directly via `requires`, resolved one layer below the capability bundle. Same
 * rule: only a `supported` node proceeds, anything weaker abstains (engine-gap),
 * and a node the graph does not model is invalid-probe. Subjects are picked OUT
 * of the generated graph so the tests track it rather than naming a verdict.
 */
describe("qualifyProbe — requires resolves graph nodes against the graph", () => {
  const cleanRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if true; }
  }
}`;
  const nodeDeps = ASSURANCE_ENGINE_CAPABILITIES.flatMap((c) => c.dependencies).filter(
    (d): d is Extract<(typeof d), { kind: "construct" | "registry-row" }> =>
      d.kind === "construct" || d.kind === "registry-row",
  );
  const supportedNode = nodeDeps.find((d) => d.verdict === "supported");
  const weakNode = nodeDeps.find((d) => d.verdict !== "supported");
  const probeRequiring = (...requires: CapabilityDependency[]): AssuranceProbe => ({
    ...firestoreProbe,
    requires,
  });

  it("proceeds when every required node is derived supported", () => {
    if (!supportedNode) throw new Error("expected a supported graph node");
    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring({ kind: supportedNode.kind, id: supportedNode.id }),
    );
    expect(qualification.supported).toBe(true);
    expect(qualification.classification).toBeUndefined();
  });

  it("abstains engine-gap, citing the node's derived verdict, when a required node is not supported", () => {
    if (!weakNode) throw new Error("expected a non-supported graph node");
    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring({ kind: weakNode.kind, id: weakNode.id }),
    );
    expect(qualification.supported).toBe(false);
    expect(qualification.classification).toBe("engine-gap");
    const failed = qualification.requirements.find((r) => r.id === weakNode.id);
    expect(failed?.supported).toBe(false);
    expect(failed?.reason).toContain(weakNode.verdict);
  });

  it("treats a node the graph does not model as invalid-probe, not an engine gap", () => {
    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring({ kind: "construct", id: "firestore.not-a-real-construct" }),
    );
    expect(qualification.supported).toBe(false);
    expect(qualification.classification).toBe("invalid-probe");
  });
});
