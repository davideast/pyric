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
