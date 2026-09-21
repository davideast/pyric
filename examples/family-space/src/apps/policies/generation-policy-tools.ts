import { prepareAuthoredPolicy } from "./authored-policy";
import { canIUse } from "@pyric/cli/conformance/browser";
import { modulesForService, resolveModulesBrowser } from "pyric/rules/internal";
import {
  chorePolicy,
  chorePolicyContract,
  checkPolicy,
  policyFixtures,
  validatePolicy,
  type Policy,
} from "./app-policy";
export type PolicySelection = {
  policy: Policy | null;
  validation?: Awaited<ReturnType<typeof validatePolicy>>;
  summary: string;
};
const references: Record<string, string> = {
  identity:
    "Use useAppIdentity() from @kin/app. Membership comes from the live host session, never the captured family context. Hide unauthorized controls, but let the host check every write. Treat signed-out/loading identity as unavailable. Never choose identity or roles in a data request.",
  modeling:
    "Inspect Rules Standard Library signatures before choosing fields. Import helpers with rules_version = '2+modules'; never copy helper bodies. Modular source is authoritative; resolved v2 is a generated artifact. Use only real product invariants. Author app-specific rules within the host capability boundary. Keep signed-out and outsider writes denied. The current-member role comes from membership documents, not token claims.",
  validation:
    "Establish an ALLOW control, then change one dimension (identity, assignment, operation, payload) and check DENY. Tests are bounded evidence, not proof for all inputs. Host-owned tests cannot be replaced by agent tests. Update progress and celebrate only after a successful saved write.",
};
export const policyCapabilities = {
  version: 2,
  boundary:
    "Local behavior enforcement in the Kin host; Firebase enforces family membership. Modified clients can bypass local policies.",
  operations: ["create", "update", "delete"],
  records: "families/{family}/apps/{app}/records/{record}",
  dependencies:
    "Host-resolved membership using request.auth.uid, resource.data.FIELD or request.resource.data.FIELD. Use literal /databases/$(database)/documents/families/$(family)/members/$(EXPRESSION) paths; other lookups fail closed.",
  unsupported: [
    "private reads",
    "queries",
    "batches",
    "getAfter",
    "arbitrary document lookups",
    "offline policy writes",
  ],
  contracts: [chorePolicyContract],
  authoring: {
    version: 2,
    membershipGuard: "Inside the records match define function member() { return request.auth != null && exists(/databases/$(database)/documents/families/$(family)/members/$(request.auth.uid)); }. Every write must require member(); authentication alone allows outsiders.",
    imports: "Read rules_stdlib_get for EVERY imported module; use only exported function names and exact signatures. Do not invent validation helpers. Do not add a recursive default-deny match: unmatched paths already deny.",
    source: "rules_version = '2+modules'; with standard-library imports. Exact nested matches: /databases/{database}/documents then /families/{family}/apps/{app}/records/{record}. No other match blocks.",
    cases: "{description, method: create|update|delete, uid: daniel|alex|sam|zoe|outsider|null, before?, after?, expectation: ALLOW|DENY}. before required for update/delete; after for create/update. 3–40 cases, a denied case per operation and at least one successful write.",
    fixtures: "daniel and alex are parents; sam and zoe are kids. Host owns memberships, auth and dependency lookup mocks.",
    validation: "Agent examples plus mandatory host boundary mutations, evaluated independently in rules and sandbox. Passing checks is bounded evidence, not proof of requested semantics.",
    updates: "set replaces the whole document. Preserve fields explicitly; use live useAppIdentity().",
  },
  fallback:
    "family-trust explicitly means no app-specific policy; do not choose it when requested permissions need enforcement.",
};
export const policyToolDescriptions = {
  app_policy_capabilities:
    "No arguments. Get Kin runtime limits and known contracts.",
  pyric_can_i_use:
    "{feature, importPath?}. Exact support lookup. An exact match is not a support verdict: inspect availability, fidelity, assurance and caveats.",
  rules_stdlib_search:
    "{query}. Find Firestore modules; discovery is not Kin runtime approval.",
  rules_stdlib_get: "{key}. Exact module signatures and examples.",
  generation_reference_get:
    "{topic: identity|modeling|validation}. Read curated guidance.",
  app_policy_prepare:
    "{id: chore-quest-v1} OR {source, summary, cases?}. Prefer source and summary ONLY, then send small case batches using app_policy_cases. Resolve and lint authored modular rules, verify dependencies, invalidate previous evidence. Prefer id for exact Chore Quest contract.",
  app_policy_cases:
    "{cases, mode?: replace|append}. Attach cases to the prepared source, 3–6 per call. Default replaces all cases; use append for subsequent batches. Each case: {description,method:create|update|delete,uid:daniel|alex|sam|zoe|outsider|null,before?,after?,expectation:ALLOW|DENY}. Omit or use null for create.before and delete.after. Never use outsider as a method. Changing cases invalidates evidence.",
  app_policy_source:
    "{id: chore-quest-v1}. Retrieve pinned modular source and schema/permission contract.",
  app_policy_test:
    "{}. Run authored cases plus non-replaceable host boundary checks in standalone and sandbox; failures include diagnostics to repair.",
  app_policy_inspect:
    "{caseIndex}. Detailed evidence from the latest successful suite.",
};
export function createGenerationPolicyTools() {
  let policy: Policy | undefined;
  let validation: PolicySelection["validation"];
  return {
    async call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
      try {
        switch (name) {
          case "app_policy_capabilities":
            return { ok: true, data: policyCapabilities };
          case "pyric_can_i_use": {
            if (typeof args.feature !== "string" || !args.feature.trim())
              throw Error("feature is required");
            const result = canIUse(
              args.feature,
              typeof args.importPath === "string"
                ? { importPath: args.importPath }
                : undefined,
            );
            return { ok: result.match === "exact", data: result };
          }
          case "rules_stdlib_search": {
            if (typeof args.query !== "string")
              throw Error("query is required");
            const words = args.query.toLowerCase().split(/\W+/).filter(Boolean);
            const catalog = modulesForService("firestore");
            return {
              ok: true,
              data: catalog
                .map((m) => ({
                  key: m.key,
                  description: m.description,
                  score: words.filter((w) =>
                    JSON.stringify(m).toLowerCase().includes(w),
                  ).length,
                }))
                .filter((m) => m.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 8),
            };
          }
          case "rules_stdlib_get": {
            const module = modulesForService("firestore").find(
              (m) => m.key === args.key,
            );
            if (!module) throw Error("Unknown Firestore module");
            return { ok: true, data: module };
          }
          case "generation_reference_get": {
            const value =
              typeof args.topic === "string"
                ? references[args.topic]
                : undefined;
            if (!value) throw Error("Unknown reference topic");
            return { ok: true, data: value };
          }
          case "app_policy_source":
            if (args.id !== chorePolicy.id)
              throw Error("Unsupported policy contract");
            return {
              ok: true,
              data: {
                source: chorePolicy.source,
                contract: policyCapabilities.contracts[0],
              },
            };
          case "app_policy_prepare": {
            policy = undefined;
            validation = undefined;
            const source =
              args.source ??
              (args.id === chorePolicy.id ? chorePolicy.source : undefined);
            if (typeof source !== "string" || source.length > 60000)
              throw Error(
                "Expected a known policy id or bounded modular source",
              );
            const result = resolveModulesBrowser(source);
            if (!result.success) throw Error(result.error.message);
            const candidate = source === chorePolicy.source
              ? chorePolicy
              : prepareAuthoredPolicy(source, args.summary, args.cases ?? [], args.cases === undefined);
            if (candidate.format === 1) checkPolicy(candidate, policyFixtures().cases[0]);
            policy = candidate;
            return {
              ok: true,
              data: {
                id: policy.id,
                modules: result.data.modules,
                engine: policy.engine,
                library: policy.library,
              },
            };
          }
          case "app_policy_cases": {
            validation = undefined;
            if (!policy || policy.format !== 2) throw Error("Prepare authored policy source first");
            if (args.mode !== undefined && args.mode !== "append" && args.mode !== "replace")
              throw Error("mode must be append or replace");
            if (!Array.isArray(args.cases)) throw Error("cases must be an array");
            const candidateCases = args.mode === "append" ? [...policy.cases, ...args.cases] : args.cases;
            policy = prepareAuthoredPolicy(policy.source, policy.summary, candidateCases, true);
            return {ok:true,data:{cases:policy.cases.length,message:"Cases saved; run app_policy_test before finishing."}};
          }
          case "app_policy_test":
            validation = undefined;
            if (!policy) throw Error("Prepare a supported policy first");
            validation = await validatePolicy(
              policy,
              [],
              policyFixtures().members,
            );
            return {
              ok: true,
              data: {
                message: "Policy checks passed",
                policyHash: validation.policyHash,
                passed: validation.passed,
                sandboxPassed: validation.sandboxPassed,
                suite: validation.suite,
              },
            };
          case "app_policy_inspect": {
            const c = validation?.cases[Number(args.caseIndex)];
            if (!c) throw Error("No validated case at this index");
            return { ok: true, data: c };
          }
          default:
            throw Error("Unknown policy tool");
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && "diagnostics" in error ? { diagnostics: error.diagnostics } : {}),
        };
      }
    },
    selection(): PolicySelection {
      if (!policy || !validation)
        throw Error("Policy must be prepared and tested");
      return {
        policy,
        validation,
        summary: policy.format === 2 ? policy.summary : policyCapabilities.contracts[0].summary,
      };
    },
  };
}
