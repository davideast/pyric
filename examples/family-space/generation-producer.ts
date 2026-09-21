import { chorePolicyContract } from "./app-policy";
import { selectPolicy, revalidatePolicySelection } from "./generation-policy";
import { selectUi } from "./ui-kit-selection";
import type { Producer } from "@inbrowser/resumable";
import { extractAppSource } from "./app-context";
import { generateWithModel, type StreamingModel } from "./generation-model";
import type {
  GenerationSpec,
  GenerationJob,
  GenerationEvent,
  DurableGeneration,
} from "./generation-types";

export function generationProducer(
  spec: GenerationSpec,
  model: () => Promise<StreamingModel>,
  compile: (source: string) => Promise<unknown>,
): Producer<DurableGeneration> {
  return async function* ({ signal }) {
    let job: GenerationJob = spec.previous ?? {
      id: spec.id,
      ownerId: spec.ownerId,
      title: spec.title,
      state: "running",
      events: [],
    };
    job = {
      ...job,
      state: "running",
      error: undefined,
      draft: undefined,
      events: job.events.map((e) => ({ ...e, running: false })),
    };
    const queue: DurableGeneration[] = [];
    let wake: (() => void) | undefined,
      done = false;
    const snapshot = () => {
      queue.push(structuredClone({ job, spec }));
      wake?.();
    };
    const check = () => {
      signal.throwIfAborted();
    };
    const event = (
      kind: GenerationEvent["kind"],
      title: string,
      detail = "",
    ) => {
      check();
      const id = job.events.length;
      job = {
        ...job,
        events: [
          ...job.events.map((e) => ({ ...e, running: false })),
          { id, kind, title, detail, running: true },
        ],
      };
      snapshot();
      return (detail: string) => {
        check();
        job = {
          ...job,
          events: job.events.map((e) => (e.id === id ? { ...e, detail } : e)),
        };
        snapshot();
      };
    };
    const work = (async () => {
      try {
        if (spec.previous)
          event(
            "result",
            "Resuming your build",
            spec.checkpoint
              ? "Restored completed model output; continuing validation."
              : "Restored activity. The interrupted model request will restart.",
          );
        else event("context", "Family context captured", spec.context);
        if (spec.policyWorkflow) {
          const policySelection = spec.policySelection
            ? await revalidatePolicySelection(
                spec.policySelection,
                spec.requiredPolicy,
              )
            : await selectPolicy(
                spec.prompt,
                await model(),
                signal,
                (title, detail) => {
                  event("tool", title, detail);
                },
                spec.requiredPolicy,
              );
          spec = { ...spec, policySelection };
          snapshot();
        }
        if (spec.uiKit && !spec.uiSelection && !spec.checkpoint) {
          event(
            "tool",
            "Selecting UI patterns",
            "Reading the Firestore catalog and checking coverage before generation.",
          );
          const uiSelection = await selectUi(
            spec.uiKit,
            spec.prompt,
            await model(),
            signal,
            (title, detail) => {
              event("tool", title, detail);
            },
          );
          spec = { ...spec, uiSelection };
          snapshot();
        }
        let previous = spec.checkpoint ?? "",
          source = "",
          issue = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!spec.checkpoint || attempt) {
            const progress = event(
              "response",
              attempt ? "Repairing the React app" : "Writing the React app",
            );
            let summaryText = "",
              summaryProgress: ((text: string) => void) | undefined;
            previous = await generateWithModel(
              await model(),
              spec.prompt +
                (spec.policySelection
                  ? `\nHost-owned policy contract: ${JSON.stringify(spec.policySelection.policy ? (spec.policySelection.policy.format === 2 ? { summary: spec.policySelection.policy.summary, rules: spec.policySelection.policy.source, permissionCases: spec.policySelection.policy.cases, writeSemantics: "set replaces the entire record; preserve unchanged fields; await saves; use live useAppIdentity()" } : chorePolicyContract) : { mode: "family-trust", summary: spec.policySelection.summary })}`
                  : "") +
                (spec.uiSelection
                  ? `\nRetrieved UI reference source (copy needed helpers into App.tsx, deduplicate imports; these are NOT installed modules):\n${spec.uiSelection.context}`
                  : "") +
                (spec.baseSource
                  ? `\nEdit this existing React app according to the requested change. Preserve all existing record IDs and the data schema. Only additive, backward-compatible data changes are allowed. Never clear or reset user records. Existing source:\n${spec.baseSource}`
                  : "") +
                (spec.repair
                  ? `\nRepair this existing app. Preserve its record IDs and data schema; do not reset data. Runtime error: ${spec.repair.error}\nExisting source:\n${spec.repair.source}`
                  : "") +
                (attempt
                  ? `\nThe previous response failed validation: ${issue}\nReturn a complete corrected React module. Previous response:\n${previous}`
                  : ""),
              spec.context,
              progress,
              signal,
              (summary) => {
                summaryText += summary;
                summaryProgress ??= event("summary", "Model reasoning summary");
                summaryProgress(summaryText);
              },
            );
            check();
            spec = { ...spec, checkpoint: previous };
            snapshot();
          }
          try {
            source = extractAppSource(previous);
            event("tool", "Checking React compilation", source);
            await compile(source);
            check();
            event(
              "result",
              "React compilation passed",
              "The app compiles successfully. Open the preview to try it before sharing.",
            );
            break;
          } catch (error) {
            check();
            issue = error instanceof Error ? error.message : String(error);
            event("error", "Validation needs a repair", issue);
            if (attempt === 1)
              throw new Error(
                "The app could not be built after a repair. " + issue,
              );
          }
        }
        check();
        const draft = {
          id: spec.id,
          ownerId: spec.ownerId,
          title: spec.title,
          prompt: spec.prompt,
          context: spec.context,
          audience: spec.audience,
          createdAt: spec.createdAt,
          published: false,
          ...(spec.policySelection?.policy
            ? { policy: spec.policySelection.policy, policyRequired: true }
            : {}),
          source,
        };
        event(
          "tool",
          "Saving your private app",
          "The generated app is retained locally. An authenticated Kin tab saves it to Firestore.",
        );
        job = { ...job, draft };
        snapshot();
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        event("error", "Build stopped", message);
        job = {
          ...job,
          state: "failed",
          error: message,
          events: job.events.map((e) => ({ ...e, running: false })),
        };
        snapshot();
      } finally {
        done = true;
        wake?.();
      }
    })();
    while (!done || queue.length) {
      if (!queue.length)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      while (queue.length) {
        check();
        yield queue.shift()!;
      }
    }
    await work;
  };
}
