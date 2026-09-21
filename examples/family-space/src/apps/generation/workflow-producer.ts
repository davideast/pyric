import { WorkflowUnavailableError } from "./build-workflow-types";
import type { Producer } from "@inbrowser/resumable";
import type {
  DurableGeneration,
  GenerationSpec,
  GenerationJob,
} from "./generation-types";
import type { WorkflowRequest } from "./workflow-bridge";
import type { WorkflowState } from "./build-workflow-types";
import type { StreamingModel } from "./generation-model";
import { runBuildWorkflow } from "./build-workflow";
export function workflowProducer(
  spec: GenerationSpec,
  model: () => Promise<StreamingModel>,
  compile: (source: string) => Promise<unknown>,
  request: (r: WorkflowRequest, s: AbortSignal) => Promise<unknown>,
): Producer<DurableGeneration> {
  return async function* ({ signal }) {
    if (!spec.workflow) throw Error("Workflow state is missing");
    let revision = spec.workflow.revision,
      state = spec.workflow.state;
    let job: GenerationJob = {
      id: spec.id,
      ownerId: spec.ownerId,
      title: spec.title,
      state: "running",
      events:
        spec.previous?.events.map((e) => ({ ...e, running: false })) ?? [],
    };
    const abort = new AbortController();
    signal.addEventListener("abort", () => abort.abort(signal.reason), {
      once: true,
    });
    const queue: DurableGeneration[] = [];
    let wake: (() => void) | undefined,
      done = false;
    const emit = () => {
      queue.push(
        structuredClone({
          spec: { ...spec, workflow: { ...spec.workflow!, revision, state } },
          job,
        }),
      );
      wake?.();
    };
    let lastStreamEmission = 0;
    const event = (title: string, detail: string) => {
      const prior = job.events.at(-1);
      if (prior?.title === title && title.endsWith("response"))
        prior.detail = detail;
      else {
        job.events.forEach((e) => (e.running = false));
        let kind: GenerationJob["events"][number]["kind"] = "tool";
        if (title.endsWith("response")) kind = "response";
        else if (title.includes("attention")) kind = "error";
        job.events.push({
          id: job.events.length,
          kind,
          title,
          detail,
          running: job.state === "running",
        });
      }
      if (title.endsWith("response")) {
        if (Date.now() - lastStreamEmission < 1000) return;
        lastStreamEmission = Date.now();
      }
      emit();
    };
    const rpc = (
      operation: WorkflowRequest["operation"],
      value?: WorkflowState,
    ) => request({ operation, spec, state: value, revision }, abort.signal);
    const timer = setInterval(() => {
      void rpc("renew").catch((e) => abort.abort(e));
    }, 20000);
    const work = (async () => {
      try {
        const result = await runBuildWorkflow(
          state,
          {
            model,
            compile,
            checkpoint: async (next) => {
              state = next;
              const saved = (await rpc("checkpoint", next)) as {
                revision: number;
              };
              revision = saved.revision;
              emit();
            },
            startup: async (next) => {
              await rpc("startup", next);
            },
            save: async (next) => {
              await rpc("save", next);
            },
            event,
          },
          abort.signal,
        );
        state = result;
        job = {
          ...job,
          state: result.status === "ready" ? "ready" : "failed",
          error: result.diagnostic,
          versionId: result.status === "ready" ? spec.buildId : undefined,
        };
        event(
          result.status === "ready"
            ? "Your app is ready"
            : "Build needs attention",
          result.diagnostic ?? "Validated and saved to Firestore.",
        );
      } catch (e) {
        let status: GenerationJob["state"] = "interrupted";
        if (signal.aborted) status = "stopped";
        else if (e instanceof WorkflowUnavailableError) status = "awaiting-tab";
        job = { ...job, state: status, error: String(e) };
        event(
          signal.aborted ? "Build stopped" : "Build interrupted",
          String(e),
        );
      } finally {
        clearInterval(timer);
        job.events.forEach((e) => (e.running = false));
        emit();
        done = true;
        wake?.();
        // Best effort: failed connections expire rather than letting another executor overwrite them.
        let finalStatus = state.status;
        if (signal.aborted) finalStatus = "cancelled";
        else if (job.state === "interrupted" || job.state === "awaiting-tab")
          finalStatus = "interrupted";
        void request(
          {
            operation: "release",
            spec,
            state: { ...state, status: finalStatus },
          },
          new AbortController().signal,
        ).catch(() => {});
      }
    })();
    while (!done || queue.length) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      while (queue.length) yield queue.shift()!;
    }
    await work;
  };
}
