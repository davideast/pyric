import { firestoreRules, type FirestoreCase } from "pyric/rules";
import { resolveModulesBrowser } from "pyric/rules/internal";
import { PolicyError, policyCase, policyFixtures, chorePolicy, type Policy, type Members } from "./app-policy";

export type AuthoredCase = {
  description: string;
  method: "create" | "update" | "delete";
  uid: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  expectation: "ALLOW" | "DENY";
};
export type AuthoredPolicy = {
  id: "authored-v1";
  format: 2;
  source: string;
  resolved: string;
  engine: string;
  library: string;
  summary: string;
  cases: AuthoredCase[];
};
function invalid(message: string): never { throw new PolicyError("invalid-policy", message); }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export function prepareAuthoredPolicy(source: string, summary: unknown, cases: unknown, allowIncompleteCases = false): AuthoredPolicy {
  if (source.length > 60000 || !source.startsWith("rules_version = '2+modules';"))
    invalid("Use bounded rules_version = '2+modules' source.");
  if (typeof summary !== "string" || !summary.trim() || summary.length > 2000)
    invalid("A permission summary is required.");
  if (!Array.isArray(cases) || (!allowIncompleteCases && cases.length < 3) || cases.length > 40 || JSON.stringify(cases).length > 60000)
    invalid("Supply 3–40 bounded permission cases.");
  const fixtures = policyFixtures();
  for (const [index, c] of cases.entries()) {
    const at = (field: string, message: string): never => invalid(`cases[${index}].${field}: ${message}`);
    if (!object(c)) at("case", "expected an object");
    if (typeof c.description !== "string" || !c.description.trim()) at("description", "expected a nonblank string");
    if (!["create", "update", "delete"].includes(String(c.method))) at("method", "expected create, update, delete");
    if (!["ALLOW", "DENY"].includes(String(c.expectation))) at("expectation", "expected ALLOW or DENY");
    if (!(c.uid === null || c.uid === "outsider" || (typeof c.uid === "string" && Object.hasOwn(fixtures.members,c.uid))))
      at("uid", "expected daniel, alex, sam, zoe, outsider, or null");
    if (c.method !== "create" && !object(c.before)) at("before", "update/delete require the existing document object");
    if (c.method !== "delete" && !object(c.after)) at("after", "create/update require the proposed document object");
    if (c.method === "create" && c.before != null) at("before", "create requires null or omission");
    if (c.method === "delete" && c.after != null) at("after", "delete requires null or omission");
  }
  if (!allowIncompleteCases) {
  for (const method of ["create", "update", "delete"])
    if (!cases.some(c => c.method === method && c.expectation === "DENY"))
      invalid("Include a denied case for every write operation.");
  if (!cases.some(c => c.expectation === "ALLOW")) invalid("Include a successful write control.");
  }
  const resolved = resolveModulesBrowser(source);
  if (!resolved.success) invalid(resolved.error.message);
  const candidate: AuthoredPolicy = {
    id: "authored-v1", format: 2, source, resolved: resolved.data.resolved,
    engine: chorePolicy.engine, library: "bundled-stdlib/kin-authored-1", summary,
    cases: cases.map(c => ({
      description:c.description, method:c.method, uid:c.uid, expectation:c.expectation,
      ...(c.before ? {before:c.before} : {}), ...(c.after ? {after:c.after} : {}),
    })),
  };
  inspectAuthoredPolicy(candidate);
  return candidate;
}

// Inspect the public parsed representation, including inactive branches and imported helpers.
// Dependency paths are deliberately literal so the host can resolve them before evaluation.
export function inspectAuthoredPolicy(policy: AuthoredPolicy) {
  if (policy.id !== "authored-v1" || policy.format !== 2 || typeof policy.source !== "string" || policy.source.length > 60000) invalid("Invalid authored policy artifact.");
  const compiled = resolveModulesBrowser(policy.source);
  if (!compiled.success || compiled.data.resolved !== policy.resolved ||
      policy.engine !== chorePolicy.engine || policy.library !== "bundled-stdlib/kin-authored-1")
    invalid("Policy artifacts do not match their source or runtime.");
  const rules = firestoreRules(policy.resolved);
  const root = rules.toJSON().service.match;
  if (root.path.raw !== "/databases/{database}/documents" || root.allows.length ||
      root.children.length !== 1 || root.children[0].path.raw !== "/families/{family}/apps/{app}/records/{record}" ||
      root.children[0].children.length)
    invalid("Policy matches must be limited to the app records path.");
  const dependencies: {side:"before"|"after"; field:string}[] = [];
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "functionCall" && ["getAfter","existsAfter"].includes(String(node.name)))
      invalid("Post-write lookups are unsupported.");
    if (node.type === "functionCall" && ["get","exists"].includes(String(node.name))) {
      const args = node.args as Record<string, unknown>[];
      const path = args?.[0];
      const raw = typeof path?.raw === "string" ? path.raw.replace(/\s/g,"") : "";
      const prefix = "/databases/$(database)/documents/families/$(family)/members/$(";
      if (args.length !== 1 || path?.type !== "pathLiteral" || !raw.startsWith(prefix) || !raw.endsWith(")"))
        invalid("Only literal current-family membership lookups are supported.");
      const expression = raw.slice(prefix.length,-1);
      if (expression !== "request.auth.uid") {
        const match = /^(request\.resource|resource)\.data\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression);
        if (!match) invalid("Membership lookup must use current UID or a top-level before/after record field.");
        dependencies.push({side:match[1] === "resource" ? "before" : "after", field:match[2]});
      }
    }
    Object.values(node).forEach(walk);
  }
  walk(rules.toJSON());
  if (dependencies.length > 16) invalid("Too many membership dependencies.");
  const issues = rules.lint();
  if (issues.some(i => i.severity === "error")) invalid("Policy lint failed: " + JSON.stringify(issues));
  return dependencies;
}
export function policyMemberIds(policy: Policy, uid: string, before?: Record<string,unknown>, after?: Record<string,unknown>) {
  const ids = [uid];
  const dependencies = policy.format === 2 ? inspectAuthoredPolicy(policy) : [{side:"after" as const,field:"assigneeId"}];
  for (const dependency of dependencies) {
    const value = (dependency.side === "before" ? before : after)?.[dependency.field];
    if (typeof value === "string" && value && !value.includes("/")) ids.push(value);
  }
  return [...new Set(ids)];
}
export function authoredFixtures(policy: AuthoredPolicy): FirestoreCase[] {
  // Re-parse untrusted persisted cases at the host boundary; do not accept custom mocks/auth.
  const prepared = prepareAuthoredPolicy(policy.source, policy.summary, policy.cases);
  const members = policyFixtures().members;
  const cases = prepared.cases.map(c => ({
    ...policyCase(c.method,c.uid,members,c.before,c.after,c.expectation),
    description:c.description,
  }));
  const controls = cases.filter(c => c.expectation === "ALLOW");
  for (const control of controls) {
    for (const uid of [null,"outsider"]) {
      cases.push({
        ...control, auth:uid ? {uid} : null, expectation:"DENY",
        description:"Host boundary: " + (uid ?? "signed out") + " " + control.description,
      });
      if (uid && control.auth?.uid) {
        const replace = (value: unknown): unknown => {
          if (value === control.auth!.uid) return uid;
          if (Array.isArray(value)) return value.map(replace);
          if (object(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,replace(v)]));
          return value;
        };
        cases.push({...control, auth:{uid}, expectation:"DENY",
          data:replace(control.data) as FirestoreCase["data"],
          resource:replace(control.resource) as FirestoreCase["resource"],
          description:"Host boundary: outsider-owned record " + control.description});
      }
    }
  }
  return cases;
}
export function incompatibleAuthoredRecords(policy: AuthoredPolicy, records: Record<string,unknown>[], members: Members) {
  const rules = firestoreRules(policy.resolved);
  return records.filter(({id,...record}) => !Object.keys(members).some(uid =>
    rules.simulate([
      policyCase("create",uid,members,undefined,record),
      policyCase("update",uid,members,record,record),
    ]).cases.some(c => c.decision === "ALLOW" && !c.unsupported)
  ));
}
