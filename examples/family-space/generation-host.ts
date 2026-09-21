import { createWorkflowBridge } from "./workflow-bridge";
import { workflowProducer } from "./workflow-producer";
import {
  createIdbJobStore,
  hostJobEngine,
  type PortLike,
} from "@inbrowser/resumable";
import { generationProducer } from "./generation-producer";
import type { StreamingModel } from "./generation-model";
import type { DurableGeneration, GenerationSpec } from "./generation-types";

export function createGenerationHost(
  model: (spec?: GenerationSpec) => Promise<StreamingModel>,
  compile: (source: string) => Promise<unknown>,
) {
  const store = createIdbJobStore<DurableGeneration>({
    dbName: "kin-generation-v1",
    defaultTtlMs: 7 * 86400000,
  });
  void store.sweepExpired?.({ olderThan: Date.now() });
  const bridge = createWorkflowBridge();
  const active = new Map<string, AbortController>();
  const host = hostJobEngine<DurableGeneration, GenerationSpec>({
    store,
    buildProducer: (spec) =>
      async function* (ctx) {
        const abort = new AbortController();
        active.set(ctx.jobId, abort);
        const iterator = (
          spec.workflow
            ? workflowProducer(spec, () => model(spec), compile, bridge.request)
            : generationProducer(spec, () => model(spec), compile)
        )({ ...ctx, signal: abort.signal })[Symbol.asyncIterator]();
        const cancelled = new Promise<null>((resolve) =>
          abort.signal.addEventListener("abort", () => resolve(null), {
            once: true,
          }),
        );
        try {
          while (true) {
            const next = await Promise.race([iterator.next(), cancelled]);
            if (next === null) {
              const last = (await store.snapshot(ctx.jobId))?.events.at(-1);
              if (last)
                yield {
                  ...last,
                  job: {
                    ...last.job,
                    state: "stopped",
                    events: last.job.events.map((e) => ({
                      ...e,
                      running: false,
                    })),
                  },
                };
              void iterator.return?.().catch(() => {});
              return;
            }
            if (next.done) return;
            yield next.value;
          }
        } finally {
          active.delete(ctx.jobId);
        }
      },
  });
  return {
    connect(port: PortLike) {
      bridge.connect(port);
      host.connect(port);
      port.addEventListener("message", (event) => {
        const message = event.data;
        if (message?.kinControl === "active")
          port.postMessage({
            kinReply: message.rid,
            value: active.has(message.jobId),
          });
        if (message?.kinControl === "retire" && !active.has(message.jobId)) {
          void store
            .finish(message.jobId, "cancelled", "Recovered in a new worker run")
            .then(() =>
              port.postMessage({ kinReply: message.rid, value: true }),
            );
        }
        if (message?.kinControl === "cancel") {
          active.get(message.jobId)?.abort();
          port.postMessage({ kinReply: message.rid, value: true });
        }
      });
    },
  };
}
