import { test, expect } from "bun:test";
import { firestoreRules } from "pyric/rules";
import { chorePolicy, policyCase } from "../app-policy";
test("assigned kid may complete a chore but cannot reassign it", () => {
  const before = { title: "Dishes", assigneeId: "sam", completed: false };
  const members = {
    sam: { role: "kid" },
    zoe: { role: "kid" },
    daniel: { role: "parent" },
  };
  const rules = firestoreRules(chorePolicy.resolved);
  expect(
    rules
      .simulate([
        policyCase(
          "update",
          "sam",
          members,
          before,
          { ...before, completed: true },
          "ALLOW",
        ),
        policyCase(
          "update",
          "sam",
          members,
          before,
          { ...before, assigneeId: "zoe" },
          "DENY",
        ),
        policyCase(
          "update",
          "zoe",
          members,
          before,
          { ...before, completed: true },
          "DENY",
        ),
      ])
      .cases.every((c) => c.passed),
  ).toBe(true);
});
import "fake-indexeddb/auto";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import { getFirestore, doc, setDoc, deleteDoc } from "pyric/firestore";
import { policyFixtures, checkPolicy, validatePolicy } from "../app-policy";
test("standalone decisions match real sandbox operations for the permission matrix", async () => {
  const { members, cases } = policyFixtures();
  for (const c of cases) {
    const sandbox = initializeSandbox();
    seedDocuments(
      sandbox,
      Object.fromEntries([
        ...Object.entries(members).map(([id, data]) => [
          "families/parkers/members/" + id,
          data,
        ]),
        ...(c.resource ? [[c.path, c.resource]] : []),
      ]),
    );
    setRules(sandbox, chorePolicy.resolved);
    const db = getFirestore(sandbox.withAuth(c.auth ?? null));
    let allowed = true;
    try {
      if (c.method === "delete") await deleteDoc(doc(db, c.path));
      else await setDoc(doc(db, c.path), c.data!);
    } catch {
      allowed = false;
    }
    expect(allowed, c.description).toBe(c.expectation === "ALLOW");
    expect(
      firestoreRules(chorePolicy.resolved).simulate([c]).cases[0].passed,
      c.description,
    ).toBe(true);
  }
});
test("validation rejects incompatible saved data and absent or unsupported policies", async () => {
  const { members } = policyFixtures();
  expect(() => checkPolicy(null, policyFixtures().cases[0])).toThrow();
  expect(() =>
    checkPolicy(
      { ...chorePolicy, resolved: "allow everything" },
      policyFixtures().cases[0],
    ),
  ).toThrow();
  await expect(
    validatePolicy(
      chorePolicy,
      [{ id: "old", title: "", completed: false, assigneeId: "sam" }],
      members,
    ),
  ).rejects.toThrow("incompatible");
  expect((await validatePolicy(chorePolicy, [], members)).failed).toBe(0);
});
