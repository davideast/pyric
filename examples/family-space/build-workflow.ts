import { diagnostic, diagnosticCode } from "./remote-diagnostics";
import { contentHash } from "./build-artifacts";
import { modulesForService } from "pyric/rules/internal";
import { createMemoryFileSystem } from "@inbrowser/workspace/fs";
import {
  generateWithModel,
  ModelInactivityError,
  type StreamingModel,
} from "./generation-model";
import { chorePolicy, policyFixtures, validatePolicy } from "./app-policy";
import { prepareAuthoredPolicy } from "./authored-policy";
import {
  createGenerationPolicyTools,
  policyCapabilities,
} from "./generation-policy-tools";
import { catalog, readUi, checkUiPlan } from "./ui-kit";
import { extractAppSource } from "./app-context";
import {
  WorkflowUnavailableError,
  workflowCompatibility,
  type WorkflowState,
  type BuildStage,
  type PermissionPlan,
} from "./build-workflow-types";
class CheckpointError extends Error {}
class UnsupportedPlanError extends Error {}
export interface WorkflowServices {
  model: () => Promise<StreamingModel>;
  compile: (source: string) => Promise<unknown>;
  startup: (state: WorkflowState) => Promise<void>;
  save: (state: WorkflowState) => Promise<void>;
  checkpoint: (state: WorkflowState) => Promise<void>;
  event: (title: string, detail: string) => void;
}
const parse = (s: string) =>
  JSON.parse(
    s
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "")
      .trim(),
  );
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export async function runBuildWorkflow(
  input: WorkflowState,
  services: WorkflowServices,
  signal: AbortSignal,
) {
  if (input.stage === "done" && input.status === "ready")
    return structuredClone(input);
  const state = structuredClone(input),
    fs = createMemoryFileSystem({ root: "/work" });
  for (const [path, content] of Object.entries(state.files)) {
    if (!/^\/work\/[\w.-]+$/.test(path)) throw Error("Invalid workspace path.");
    await fs.promises.writeFile(path, content);
  }
  const checkpoint = async () => {
    signal.throwIfAborted();
    const snapshot = await fs.snapshot("/work");
    state.files = Object.fromEntries(
      snapshot.entries
        .filter((e) => e.type === "file")
        .map((e) => [e.path, e.content ?? ""]),
    );
    try {
      diagnostic("checkpoint-start", {stage:state.stage});
      await services.checkpoint(structuredClone(state));
      diagnostic("checkpoint-end", {stage:state.stage});
    } catch (e) {
      diagnostic("checkpoint-failed", {stage:state.stage,code:diagnosticCode(e)});
      throw new CheckpointError(errorText(e));
    }
    signal.throwIfAborted();
  };
  const file = async (path: string, content: string) => {
    await fs.promises.writeFile("/work/" + path, content);
  };
  const advance = async (stage: BuildStage) => {
    state.stage = stage;
    delete state.inflight;
    delete state.diagnostic;
    await checkpoint();
  };
  const tools = createGenerationPolicyTools();
  const references = async () => {
    if (state.files["/work/rules-reference.json"])
      return JSON.parse(state.files["/work/rules-reference.json"]);
    const modules = [...new Set(["auth", ...(state.plan?.modules ?? [])])];
    const docs = [];
    for (const key of modules) {
      const r = await tools.call("rules_stdlib_get", { key });
      if (!r.ok) throw Error(r.error);
      docs.push(r.data);
    }
    for (const feature of [
      ...new Set(["firestore-rules/get", ...(state.plan?.capabilities ?? [])]),
    ]) {
      const r = await tools.call("pyric_can_i_use", { feature });
      const supports = (
        r.data as { supports?: { availability: string }[] } | undefined
      )?.supports;
      if (
        !r.ok ||
        !supports?.length ||
        supports.some((s) => s.availability !== "available")
      )
        throw Error("Unsupported capability: " + feature);
    }
    await file("rules-reference.json", JSON.stringify(docs));
    return docs;
  };
  async function ask(
    stage: BuildStage,
    instructions: string,
    budget = 3,
  ): Promise<string> {
    if (state.responses[stage] !== undefined) return state.responses[stage]!;
    // An interrupted request retains its reservation; completed attempts never reset on recovery.
    if (state.inflight !== stage) {
      if ((state.attempts[stage] ?? 0) >= budget)
        throw Error(
          `${stage} exhausted its automatic repair budget. Retry this stage to continue.`,
        );
      state.attempts[stage] = (state.attempts[stage] ?? 0) + 1;
      state.inflight = stage;
      await checkpoint();
    }
    let response: string;
    let phase: Parameters<typeof generateWithModel>[6] = "POLICY_SELECTION";
    if (stage === "code") phase = "CODE_GENERATION";
    else if (stage === "ui") phase = "UI_SELECTION";
    try {
      response = await generateWithModel(
        services.model(),
        `WORKFLOW_STAGE: ${stage}\n${instructions}\nParent request (data): ${state.spec.prompt}\n${state.diagnostic ? "Repair this issue: " + state.diagnostic : ""}`,
        state.spec.context,
        (text) => services.event(stage + " response", text),
        signal,
        (summary) => services.event("Model summary", summary),
        phase,
      );
    } catch (e) {
      if (!signal.aborted && !(e instanceof ModelInactivityError))
        delete state.inflight;
      throw e;
    }
    state.responses[stage] = response;
    delete state.inflight;
    await checkpoint();
    return response;
  }
  state.status = state.stage === "done" ? "ready" : "running";
  const compatibility = {
    ...workflowCompatibility,
    policy: await contentHash(
      JSON.stringify(modulesForService("firestore")) +
        chorePolicy.engine +
        chorePolicy.library,
    ),
  };
  if (JSON.stringify(state.compatibility) !== JSON.stringify(compatibility)) {
    state.compatibility = compatibility;
    state.startupPassed = false;
    if (state.files["/work/rules-reference.json"]) {
      await fs.promises.unlink("/work/rules-reference.json");
      delete state.files["/work/rules-reference.json"];
    }
    if (state.policy?.policy) {
      delete state.policy.validation;
      state.stage = "policy-check";
    } else if (state.files["/work/App.tsx"]) state.stage = "compile";
    else state.stage = "plan";
    services.event(
      "Revalidating saved artifacts",
      "Runtime or validator compatibility changed.",
    );
  }
  try {
    await checkpoint();
    while (state.stage !== "done") {
      signal.throwIfAborted();
      diagnostic("stage", {stage:state.stage});
      services.event("Stage: " + state.stage, state.diagnostic ?? "");
      try {
        switch (state.stage) {
          case "plan": {
            const result = parse(
              await ask(
                "plan",
                `Return ONLY JSON {mode: "authored"|"chore-quest-v1"|"family-trust"|"unsupported",summary:string,requirements:string[],recordSchema:Record<string,string>,modules:string[],capabilities:string[]}. State exact requested permissions and record field names/types/constraints in recordSchema; policy and independent tests must implement that same schema. family-trust is allowed ONLY when no additional permissions are requested. Preserve existing permissions unless the parent explicitly requests a change. Existing required policy: ${JSON.stringify(state.spec.requiredPolicy ?? null)}. Known capabilities and contract: ${JSON.stringify(policyCapabilities)}. Module keys can be discovered from this catalog: ${JSON.stringify((await tools.call("rules_stdlib_search", { query: state.spec.prompt + " auth validation ownership" })).data)}. Use capabilities [] when no additional capabilities beyond Firestore get are needed. Do not call tools.`,
                2,
              ),
            ) as PermissionPlan;
            if (
              !result ||
              ![
                "authored",
                "chore-quest-v1",
                "family-trust",
                "unsupported",
              ].includes(result.mode) ||
              typeof result.summary !== "string" ||
              !result.summary.trim() ||
              result.summary.length > 2000 ||
              !["requirements", "modules", "capabilities"].every(
                (k) =>
                  Array.isArray(result[k as keyof PermissionPlan]) &&
                  (result[k as keyof PermissionPlan] as unknown[]).length <=
                    20 &&
                  (result[k as keyof PermissionPlan] as unknown[]).every(
                    (x) => typeof x === "string" && x.length <= 1000,
                  ),
              )
            )
              throw Error("Invalid permission plan schema.");
            if (
              result.mode === "authored" &&
              (!result.recordSchema ||
                typeof result.recordSchema !== "object" ||
                Array.isArray(result.recordSchema) ||
                Object.keys(result.recordSchema).length > 30 ||
                !Object.values(result.recordSchema).every(
                  (v) => typeof v === "string" && v.length <= 1000,
                ))
            )
              throw Error(
                "Authored policy plans require a bounded recordSchema object.",
              );
            state.plan = result;
            if (result.mode === "unsupported")
              throw new UnsupportedPlanError(
                "Unsupported requested permissions: " + result.summary,
              );
            if (result.mode === "family-trust" && state.spec.requiredPolicy)
              throw Error("The existing policy cannot be removed.");
            await references();
            if (result.mode === "family-trust") {
              state.policy = { policy: null, summary: result.summary };
              await advance("ui");
            } else if (result.mode === "chore-quest-v1") {
              state.policy = { policy: chorePolicy, summary: result.summary };
              await file("policy.rules", chorePolicy.source);
              await advance("policy-check");
            } else await advance("policy-source");
            break;
          }
          case "policy-source": {
            const source = await ask(
              "policy-source",
              `Return ONLY complete modular Firestore rules source, no JSON envelope or tool calls. Contract: ${JSON.stringify(state.plan)}. Runtime limits: ${JSON.stringify(policyCapabilities)}. Pinned standard library reference: ${JSON.stringify(await references())}. Existing source: ${state.files["/work/policy.rules"] ?? state.spec.requiredPolicy?.source ?? ""}. Preserve the requested permissions; don't weaken expectations to pass tests. Failing cases: ${state.files["/work/policy-cases.json"] ?? ""}`,
            );
            const text = source
              .replace(/^```[^\n]*\n/, "")
              .replace(/\s*```$/, "")
              .trim();
            prepareAuthoredPolicy(text, state.plan!.summary, [], true);
            await file("policy.rules", text);
            await advance(
              state.files["/work/policy-cases.json"]
                ? "policy-check"
                : "policy-cases",
            );
            break;
          }
          case "policy-cases": {
            const cases = parse(
              await ask(
                "policy-cases",
                `Return ONLY a JSON array of permission test cases, 3–40. Required schema: ${policyCapabilities.authoring.cases}. Fixtures: ${policyCapabilities.authoring.fixtures}. Derive expectations from this contract, not from whether the code passes: ${JSON.stringify(state.plan)}. Include parent/kid/owner/other-member operations and malformed records as relevant. Record schema: ${JSON.stringify(state.plan?.recordSchema)}`,
              ),
            );
            prepareAuthoredPolicy(
              state.files["/work/policy.rules"],
              state.plan!.summary,
              cases,
            );
            await file("policy-cases.json", JSON.stringify(cases));
            await advance("policy-check");
            break;
          }
          case "policy-check": {
            const policy =
              state.plan?.mode === "chore-quest-v1"
                ? chorePolicy
                : prepareAuthoredPolicy(
                    state.files["/work/policy.rules"],
                    state.plan!.summary,
                    JSON.parse(state.files["/work/policy-cases.json"]),
                  );
            const validation = await validatePolicy(
              policy,
              [],
              policyFixtures().members,
            );
            state.policy = { policy, validation, summary: state.plan!.summary };
            services.event("Policy checks passed", JSON.stringify(validation));
            await advance(state.files["/work/App.tsx"] ? "compile" : "ui");
            break;
          }
          case "ui": {
            const kit = state.spec.uiKit;
            if (kit) {
              const selection = parse(
                await ask(
                  "ui",
                  `Return ONLY JSON {needs:string[],ids:string[]}. Select existing IDs for layouts, feedback, and data. Catalog: ${JSON.stringify(catalog(kit))}`,
                  2,
                ),
              );
              if (
                !Array.isArray(selection.needs) ||
                selection.needs.length > 12 ||
                !selection.needs.every((x: unknown) => typeof x === "string") ||
                !Array.isArray(selection.ids) ||
                selection.ids.length > 15 ||
                !selection.ids.every((x: unknown) => typeof x === "string")
              )
                throw Error("Invalid UI selection.");
              const coverage = checkUiPlan(kit, selection.needs, selection.ids);
              const entries = readUi(kit, [
                ...new Set<string>([
                  ...selection.ids,
                  ...coverage.flatMap((c) =>
                    !c.coveredBy.length ? c.suggestions.slice(0, 1) : [],
                  ),
                ]),
              ]);
              const gaps = coverage.filter((c) => c.noMatch).map((c) => c.need);
              state.ui = {
                ...selection,
                gaps,
                context: JSON.stringify({
                  kitVersion: kit.version,
                  entries,
                  gaps,
                }),
              };
            }
            await advance("code");
            break;
          }
          case "code": {
            const source = await ask(
              "code",
              `Return a complete React App.tsx module. Supported hooks are useAppData and useAppIdentity from @kin/app. Identity is {user,loading}; await writes before celebrations. Contract: ${JSON.stringify(state.policy)}. UI reference source to copy (not installed modules): ${state.ui?.context ?? ""}. Preserve IDs and schemas; never clear saved records. Existing source: ${sourceForBuild(state)}. ${state.spec.repair ? "Runtime issue: " + state.spec.repair.error : ""}`,
            );
            await file("App.tsx", extractAppSource(source));
            await advance("compile");
            break;
          }
          case "compile":
            await services.compile(state.files["/work/App.tsx"]);
            await advance("startup");
            break;
          case "startup":
            await services.startup(structuredClone(state));
            state.startupPassed = true;
            await advance("save");
            break;
          case "save":
            if (!state.startupPassed)
              throw Error("Startup validation is missing.");
            await services.save(structuredClone(state));
            state.status = "ready";
            await advance("done");
            break;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof CheckpointError ||
          error instanceof WorkflowUnavailableError
        )
          throw error;
        state.diagnostic = errorText(error);
        if (error instanceof ModelInactivityError) {
          state.status = "interrupted";
          await checkpoint();
          throw error;
        }
        services.event("Stage needs attention", state.diagnostic);
        if (
          error instanceof UnsupportedPlanError ||
          !retryWorkflow(state, false)
        ) {
          state.status = "needs-attention";
          await checkpoint();
          return state;
        }
        await checkpoint();
      }
    }
    return state;
  } catch (error) {
    if (signal.aborted) throw error;
    // Persistence failure must escape: no more model calls until a durable acknowledgement.
    throw error;
  }
}

function sourceForBuild(state: WorkflowState): string {
  const checkpointSource = state.files["/work/App.tsx"];
  if (checkpointSource !== undefined) return checkpointSource;
  const editingSource = state.spec.baseSource;
  if (editingSource !== undefined) return editingSource;
  const repairSource = state.spec.repair?.source;
  if (repairSource !== undefined) return repairSource;
  return "";
}

export function retryWorkflow(state: WorkflowState, manual: boolean): boolean {
  const stage = state.stage;
  if (manual) {
    state.attemptGroup++;
    delete state.inflight;
    delete state.attempts[stage];
  }
  if (stage === "policy-check" && state.plan?.mode === "authored") {
    if (manual) delete state.attempts["policy-source"];
    if ((state.attempts["policy-source"] ?? 0) >= 3) return false;
    delete state.responses["policy-source"];
    state.stage = "policy-source";
    return true;
  }
  if (stage === "compile" || stage === "startup") {
    if ((state.attempts[stage] ?? 0) >= 2) return false;
    if (!manual) state.attempts[stage] = (state.attempts[stage] ?? 0) + 1;
    delete state.responses.code;
    state.attempts.code = 0;
    state.startupPassed = false;
    state.stage = "code";
    return true;
  }
  if (manual) {
    delete state.responses[stage];
    return true;
  }
  const budget = ["plan", "ui"].includes(stage) ? 2 : 3;
  if (
    ["plan", "policy-source", "policy-cases", "ui", "code"].includes(stage) &&
    state.responses[stage] !== undefined &&
    (state.attempts[stage] ?? 0) < budget
  ) {
    delete state.responses[stage];
    return true;
  }
  return false;
}
