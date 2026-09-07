import { expect, test } from "bun:test";
import { LocalEnvironment } from "../../src/firestore/sandbox/local-environment.js";
const rules = `rules_version = '2'; service cloud.firestore {
 match /databases/{database}/documents {
  function member() { return get(/databases/$(database)/documents/members/$(request.auth.uid)).data; }
  function active() { return request.auth != null && request.auth.token.firebase.sign_in_provider != 'anonymous' && member().status == 'active'; }
  function staff() { return active() && member().role == 'coach'; }
  function guardian(id) { return active() && request.auth.uid in get(/databases/$(database)/documents/athletes/$(id)).data.guardianUids; }
  function published(data) { return data.visibility == 'public' && data.status in ['scheduled', 'changed']; }
  match /meets/{id} { allow list: if request.query.limit <= 100 && (published(resource.data) || staff()); }
  match /athletes/{id} { allow list: if request.query.limit <= 100 && (staff() || (active() && request.auth.uid in resource.data.guardianUids)); }
  match /results/{id} { allow list: if request.query.limit <= 50 && (staff() || (resource.data.published == true && guardian(resource.data.athleteId))); }
  match /{document=**} { allow read: if false; }
 }
}`;
const where = (
  field: string,
  op: "==" | "in" | "array-contains",
  value: unknown,
) => ({ kind: "where" as const, field, op, value });
test("application list shapes are proved from constraints, with auth and lookup residuals", () => {
  const env = new LocalEnvironment();
  try {
    env.seed({
      rules,
      documents: {
        "members/parent": { status: "active", role: "parent" },
        "athletes/a": { guardianUids: ["parent"] },
        "athletes/b": { guardianUids: ["other"] },
      },
    });
    const parent = {
      uid: "parent",
      token: { firebase: { sign_in_provider: "password" } },
    };
    const run = (
      path: string,
      filters: ReturnType<typeof where>[],
      auth: typeof parent | null = null,
      limitCount = 50,
    ) =>
      env.runQuery({
        scope: { kind: "collection", path },
        auth,
        execution: { filters, orders: [], limitCount, limitFromEnd: false },
      }).allowed;
    expect(
      run("meets", [
        where("visibility", "==", "public"),
        where("status", "in", ["scheduled", "changed"]),
      ]),
    ).toBe(true);
    expect(
      run("meets", [
        where("visibility", "==", "public"),
        where("status", "in", ["scheduled", "draft"]),
      ]),
    ).toBe(false);
    expect(run("meets", [where("status", "in", ["scheduled"])])).toBe(false);
    expect(
      run(
        "meets",
        [
          where("visibility", "==", "public"),
          where("status", "in", ["scheduled"]),
        ],
        null,
        101,
      ),
    ).toBe(false);
    expect(
      run(
        "athletes",
        [where("guardianUids", "array-contains", "parent")],
        parent,
      ),
    ).toBe(true);
    expect(
      run(
        "athletes",
        [where("guardianUids", "array-contains", "other")],
        parent,
      ),
    ).toBe(false);
    expect(run("athletes", [], parent)).toBe(false);
    expect(
      run("athletes", [where("guardianUids", "array-contains", "parent")], {
        uid: "parent",
        token: { firebase: { sign_in_provider: "anonymous" } },
      }),
    ).toBe(false);
    expect(
      run(
        "results",
        [where("published", "==", true), where("athleteId", "==", "a")],
        parent,
      ),
    ).toBe(true);
    expect(
      run(
        "results",
        [where("published", "==", true), where("athleteId", "==", "b")],
        parent,
      ),
    ).toBe(false);
    expect(run("results", [where("athleteId", "==", "a")], parent)).toBe(false);
  } finally {
    env.dispose();
  }
});

test("array membership never proves list shape, absence, or negated predicates", () => {
  const env = new LocalEnvironment();
  try {
    for (const predicate of [
      "'parent' in resource.data.guardianUids && resource.data.guardianUids.size() == 1",
      "!('parent' in resource.data.guardianUids)",
      "'parent' in resource.data.guardianUids && !('secret' in resource.data)",
    ]) {
      env.seed({
        rules: `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /athletes/{id} { allow list: if ${predicate}; } } }`,
        documents: {},
      });
      expect(
        env.runQuery({
          scope: { kind: "collection", path: "athletes" },
          auth: null,
          execution: {
            filters: [where("guardianUids", "array-contains", "parent")],
            orders: [],
            limitFromEnd: false,
          },
        }).allowed,
      ).toBe(false);
    }
  } finally {
    env.dispose();
  }
});

test("every finite lookup alternative is checked, including an unauthorized last value", () => {
  const env = new LocalEnvironment();
  try {
    env.seed({
      rules,
      documents: {
        "members/parent": { status: "active", role: "parent" },
        "athletes/a": { guardianUids: ["parent"] },
        "athletes/b": { guardianUids: ["other"] },
      },
    });
    const filters = [
      where("published", "==", true),
      where("athleteId", "in", ["a", "b"]),
    ];
    expect(
      env.runQuery({
        scope: { kind: "collection", path: "results" },
        auth: {
          uid: "parent",
          token: { firebase: { sign_in_provider: "password" } },
        },
        execution: { filters, orders: [], limitCount: 50, limitFromEnd: false },
      }).allowed,
    ).toBe(false);
  } finally {
    env.dispose();
  }
});

test("public query listeners deliver supported membership results and reject broad alternatives", async () => {
  const { initializeSandbox } = await import("pyric/sandbox");
  const { getInternalEnv } = await import("pyric/sandbox/internal");
  const {
    getFirestore,
    collection,
    query,
    where: filter,
    limit,
    onSnapshot,
  } = await import("../../src/firestore/index.js");
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  try {
    env.seed({
      rules,
      documents: {
        "meets/a": { visibility: "public", status: "scheduled" },
        "meets/b": { visibility: "public", status: "changed" },
        "meets/draft": { visibility: "public", status: "draft" },
      },
    });
    const db = getFirestore(sandbox);
    for (const statuses of [
      ["scheduled", "changed"],
      ["scheduled", "draft"],
    ]) {
      let seen: string[] | undefined;
      const errors: unknown[] = [];
      const stop = onSnapshot(
        query(
          collection(db, "meets"),
          filter("visibility", "==", "public"),
          filter("status", "in", statuses),
          limit(100),
        ),
        (snapshot) => {
          seen = snapshot.docs.map((doc) => doc.id).sort();
        },
        (error) => errors.push(error),
      );
      env.flushListeners();
      if (statuses[1] === "changed") {
        expect(seen).toEqual(["a", "b"]);
        expect(errors).toHaveLength(0);
      } else {
        expect(seen).toBeUndefined();
        expect(errors).toHaveLength(1);
      }
      stop();
    }
  } finally {
    sandbox.dispose();
  }
});
