import { inspectAuthoredPolicy, authoredFixtures, incompatibleAuthoredRecords, type AuthoredPolicy } from "./authored-policy";
import { initializeSandbox } from "pyric/sandbox";
import { seedDocuments, setRules } from "pyric/sandbox/firestore";
import { getFirestore, doc, setDoc, deleteDoc } from "pyric/firestore";
import { firestoreRules, type FirestoreCase } from "pyric/rules";
import { resolveModulesBrowser } from "pyric/rules/internal";
export type Policy = AuthoredPolicy | {
  id: "chore-quest-v1";
  format: 1;
  source: string;
  resolved: string;
  engine: string;
  library: string;
};
export const chorePolicyContract = {
  id: "chore-quest-v1",
  summary:
    "Parents create, rename, assign, complete, undo and delete chores. Kids only change completed on their assigned chores. Preserve additional fields.",
  fields: {
    title: "nonblank string, max 160",
    assigneeId: "current member UID",
    completed: "boolean",
  },
  identity:
    "Use useAppIdentity; parents manage, kids toggle only their assigned chores. Await saved writes before progress or celebration.",
};
export type Members = Record<string, Record<string, unknown>>;
const source = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore {
 match /databases/{database}/documents {
  match /families/{family}/apps/{app}/records/{record} {
   function member() { return isAuthenticated() && exists(/databases/$(database)/documents/families/$(family)/members/$(request.auth.uid)); }
   function parent() { return member() && get(/databases/$(database)/documents/families/$(family)/members/$(request.auth.uid)).data.role == 'parent'; }
   function valid() { return request.resource.data.title is string
    && request.resource.data.title.size() <= 160 && request.resource.data.title.matches('.*[^\\\\s].*')
    && request.resource.data.assigneeId is string
    && exists(/databases/$(database)/documents/families/$(family)/members/$(request.resource.data.assigneeId))
    && request.resource.data.completed is bool; }
   allow read: if member();
   allow create: if request.auth != null && parent() && valid();
   allow delete: if request.auth != null && parent();
   allow update: if request.auth != null && valid() && (parent() || (member()
    && get(/databases/$(database)/documents/families/$(family)/members/$(request.auth.uid)).data.role == 'kid'
    && resource.data.assigneeId == request.auth.uid
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['completed'])));
  }
 }
}`;
const compiled = resolveModulesBrowser(source);
if (!compiled.success) throw Error(compiled.error.message);
export const chorePolicy: Policy = {
  id: "chore-quest-v1",
  format: 1,
  source,
  resolved: compiled.data.resolved,
  engine: "pyric-0.1.0-alpha.22/kin-policy-1",
  library: "bundled-auth-v1",
};
export class PolicyError extends Error {
  constructor(
    public code:
      | "denied"
      | "unsupported"
      | "stale-version"
      | "backend"
      | "invalid-policy"
      | "session",
    message: string,
    public diagnostics: unknown = null,
  ) {
    super(message);
  }
}
export function policyCase(
  method: "create" | "update" | "delete",
  uid: string | null,
  members: Members,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  expectation: "ALLOW" | "DENY" = "ALLOW",
  family = "parkers",
  app = "pilot",
  id = "chore",
): FirestoreCase {
  return {
    description: method + " " + uid,
    expectation,
    method,
    path: `families/${family}/apps/${app}/records/${id}`,
    auth: uid ? { uid } : null,
    resource: before,
    data: after,
    functionMocks: Object.entries(members).flatMap(([id, data]) => [
      {
        function: "get" as const,
        path: `families/${family}/members/${id}`,
        result: data,
      },
    ]),
  };
}
export function checkPolicy(
  policy: Policy | null | undefined,
  request: FirestoreCase,
) {
  // Validate persisted artifacts before evaluating any request.
  if (
    !policy ||
    (policy.format !== 2 && (policy.id !== chorePolicy.id ||
    policy.format !== 1 ||
    policy.resolved !== chorePolicy.resolved ||
    policy.source !== chorePolicy.source ||
    policy.engine !== chorePolicy.engine ||
    policy.library !== chorePolicy.library))
  )
    throw new PolicyError(
      "invalid-policy",
      "This app policy is missing or unsupported.",
    );
  if (policy.format === 2) {
    inspectAuthoredPolicy(policy);
    const uid = request.auth?.uid;
    const family = request.path.split("/")[1];
    const memberPath = `families/${family}/members/${uid}`;
    if (!uid || !request.functionMocks?.some(m => m.function === "get" && m.path === memberPath && m.result))
      throw new PolicyError("denied", "Current family membership is required.");
  }
  const result = firestoreRules(policy.resolved).simulate([request]).cases[0];
  if (result.decision !== "ALLOW")
    throw new PolicyError(
      result.unsupported ? "unsupported" : "denied",
      "This action is not allowed for your account.",
      result,
    );
  return result;
}
export function policyFixtures() {
  const members: Members = {
    daniel: { role: "parent" },
    alex: { role: "parent" },
    sam: { role: "kid" },
    zoe: { role: "kid" },
  };
  const before = {
    title: "Dishes",
    assigneeId: "sam",
    completed: false,
    extra: "preserved",
  };
  const cases: FirestoreCase[] = [];
  for (const uid of ["daniel", "alex", "sam", "zoe", "outsider", null]) {
    const parent = uid === "daniel" || uid === "alex";
    cases.push(
      policyCase(
        "create",
        uid,
        members,
        undefined,
        before,
        parent ? "ALLOW" : "DENY",
      ),
    );
    cases.push(
      policyCase(
        "delete",
        uid,
        members,
        before,
        undefined,
        parent ? "ALLOW" : "DENY",
      ),
    );
    cases.push(
      policyCase(
        "update",
        uid,
        members,
        before,
        { ...before, completed: true },
        parent || uid === "sam" ? "ALLOW" : "DENY",
      ),
    );
  }
  cases.push(
    policyCase(
      "update",
      "sam",
      members,
      { ...before, completed: true },
      before,
      "ALLOW",
    ),
  );
  for (const change of [
    { assigneeId: "zoe" },
    { title: "New name" },
    { extra: "changed" },
    { injected: true },
  ])
    cases.push(
      policyCase(
        "update",
        "sam",
        members,
        before,
        { ...before, ...change },
        "DENY",
      ),
    );
  for (const change of [
    { title: "" },
    { title: "   " },
    { title: "x".repeat(161) },
    { completed: "yes" },
    { assigneeId: "outsider" },
  ])
    cases.push(
      policyCase(
        "create",
        "daniel",
        members,
        undefined,
        { ...before, ...change },
        "DENY",
      ),
    );
  return { members, cases };
}
export async function validatePolicy(
  policy: Policy,
  records: Record<string, unknown>[],
  members: Members,
) {
  if (policy.format === 2) inspectAuthoredPolicy(policy);
  else checkPolicy(policy, policyFixtures().cases[0]);
  const rules = firestoreRules(policy.resolved),
    issues = rules.lint();
  if (issues.some((issue) => issue.severity === "error"))
    throw new PolicyError("invalid-policy", "Policy lint failed.", issues);
  const fixture = policyFixtures();
  const cases = policy.format === 2 ? authoredFixtures(policy) : fixture.cases;
  const summary = rules.simulate(cases);
  if (summary.failed || summary.unsupported)
    throw new PolicyError("invalid-policy", "Policy checks failed.", summary);
  let sandboxPassed = 0;
  for (const c of cases) {
    const sandbox = initializeSandbox();
    seedDocuments(
      sandbox,
      Object.fromEntries([
        ...Object.entries(fixture.members).map(([id, data]) => [
          "families/parkers/members/" + id,
          data,
        ]),
        ...(c.resource ? [[c.path, c.resource]] : []),
      ]),
    );
    setRules(sandbox, policy.resolved);
    const db = getFirestore(sandbox.withAuth(c.auth ?? null));
    let allowed = true;
    try {
      if (c.method === "delete") await deleteDoc(doc(db, c.path));
      else await setDoc(doc(db, c.path), c.data!);
    } catch (e) {
      if (
        (e as { code?: string }).code !== "permission-denied" &&
        (e as { code?: string }).code !== "firestore/permission-denied"
      )
        throw new PolicyError(
          "unsupported",
          "Sandbox validation could not finish.",
          String(e),
        );
      allowed = false;
    }
    if (allowed !== (c.expectation === "ALLOW"))
      throw new PolicyError(
        "invalid-policy",
        "Sandbox policy checks failed.",
        c.description,
      );
    sandboxPassed++;
  }
  const incompatible = policy.format === 2 ? incompatibleAuthoredRecords(policy, records, members) : records.filter(
    (r) =>
      typeof r.title !== "string" ||
      !r.title.trim() ||
      r.title.length > 160 ||
      typeof r.completed !== "boolean" ||
      typeof r.assigneeId !== "string" ||
      !members[r.assigneeId],
  );
  if (incompatible.length)
    throw new PolicyError(
      "invalid-policy",
      "Existing records are incompatible with this policy. Review them before activation.",
      incompatible.map((r) => r.id),
    );
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(policy.resolved),
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  return {
    policyHash: hash,
    fixtureRevision: "kin-members-v1",
    sandboxPassed,
    suite: policy.format === 2 ? "authored-policy-host-v1" : "chore-policy-v1",
    engine: policy.engine,
    library: policy.library,
    issues,
    passed: summary.passed,
    failed: summary.failed,
    unsupported: summary.unsupported,
    cases: summary.cases.map((c) => ({
      description: c.description,
      expectation: c.expectation,
      decision: c.decision,
      passed: c.passed,
      notes: c.notes,
      explanation: c.trace.map((rule) => ({
        condition: rule.conditionText,
        verdict: rule.verdict,
        operations: rule.operations,
      })),
    })),
  };
}
