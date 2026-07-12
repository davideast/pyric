import { describe, expect, it } from "bun:test";
import {
  ASSURANCE_ENGINE_CAPABILITIES,
  qualifyProbe,
} from "../../src/assurance/capabilities.js";
import type {
  AssuranceProbe,
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
 * The abstention wiring: a probe's declared capability is resolved against the
 * status the CONFORMANCE GRAPH derived for it, not against a hand-written list.
 *
 * These tests pick their subject capabilities OUT of the generated module rather
 * than naming a status inline. The derived statuses are allowed to move as the
 * graph learns; what must never move is the rule — only `supported` lets a probe
 * proceed, and anything weaker abstains while citing the graph's own evidence.
 */
describe("qualifyProbe — capability requirements resolve against the graph", () => {
  // A target + probe that qualifies on every target-specific check, so the ONLY
  // thing that can disqualify it is the declared capability.
  const cleanRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} { allow update: if true; }
  }
}`;
  const probeRequiring = (...requirements: string[]): AssuranceProbe => ({
    ...firestoreProbe,
    requirements,
  });

  it("abstains with engine-gap, citing the graph's reasons, when a required capability is not supported", () => {
    const notSupported = ASSURANCE_ENGINE_CAPABILITIES.find(
      (capability) => capability.status !== "supported",
    );
    if (!notSupported) throw new Error("expected a non-supported capability");
    // The graph must have said WHY; an abstention with no evidence is not one.
    expect(notSupported.reasons.length).toBeGreaterThan(0);

    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring(notSupported.id),
    );

    expect(qualification.supported).toBe(false);
    expect(qualification.classification).toBe("engine-gap");

    const failed = qualification.requirements.find(
      (requirement) => requirement.id === notSupported.id,
    );
    expect(failed?.supported).toBe(false);
    // The abstention message carries the capability's derived status AND the
    // graph evidence that pinned it — the probe cites the graph, not a hunch.
    expect(failed?.reason).toContain(notSupported.status);
    expect(failed?.reason).toContain(notSupported.reasons[0]!);
  });

  it("lets a probe proceed when its required capability is derived supported", () => {
    const supported = ASSURANCE_ENGINE_CAPABILITIES.find(
      (capability) => capability.status === "supported",
    );
    if (!supported) throw new Error("expected a supported capability");

    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring(supported.id),
    );

    expect(qualification.supported).toBe(true);
    expect(qualification.classification).toBeUndefined();
  });

  it("treats an unknown capability id as invalid-probe, not as an engine gap", () => {
    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring("firestore.not-a-real-capability"),
    );

    expect(qualification.supported).toBe(false);
    // A campaign that names a capability the engine does not define is a
    // malformed campaign. That is the author's error, not the engine's gap.
    expect(qualification.classification).toBe("invalid-probe");
  });

  it("an unknown id outranks a non-supported one: the campaign is malformed first", () => {
    const notSupported = ASSURANCE_ENGINE_CAPABILITIES.find(
      (capability) => capability.status !== "supported",
    );
    if (!notSupported) throw new Error("expected a non-supported capability");

    const qualification = qualifyProbe(
      firestoreTarget(cleanRules),
      probeRequiring(notSupported.id, "firestore.not-a-real-capability"),
    );

    expect(qualification.classification).toBe("invalid-probe");
  });
});
