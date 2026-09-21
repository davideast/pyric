import { WorkflowUnavailableError } from "./build-workflow-types";
import type { PortLike } from "@inbrowser/resumable";
import type { GenerationSpec } from "./generation-types";
import type { WorkflowState } from "./build-workflow-types";
export type WorkflowRequest = {
  operation: "checkpoint" | "renew" | "release" | "startup" | "save";
  spec: GenerationSpec;
  state?: WorkflowState;
  revision?: number;
};
function exchange(
  port: PortLike,
  message: Record<string, unknown>,
  signal: AbortSignal,
  timeout: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const finish = (error?: unknown, value?: unknown) => {
      clearTimeout(timer);
      port.removeEventListener("message", listener);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const listener = (e: MessageEvent) => {
      if (e.data?.kinWorkflowReply !== id) return;
      finish(e.data.error ? Error(e.data.error) : undefined, e.data.value);
    };
    const abort = () => finish(signal.reason ?? Error("Build stopped"));
    const timer = setTimeout(
      () =>
        finish(
          new WorkflowUnavailableError(
            "Awaiting an authenticated Kin tab. The request was not acknowledged.",
          ),
        ),
      timeout,
    );
    port.addEventListener("message", listener);
    signal.addEventListener("abort", abort, { once: true });
    port.postMessage({ ...message, kinWorkflowRequest: id });
  });
}
export function createWorkflowBridge() {
  const ports = new Map<PortLike, string>();
  return {
    connect(port: PortLike) {
      port.addEventListener("message", (e) => {
        if (e.data?.kinWorkflow === "attach" && typeof e.data.uid === "string")
          ports.set(port, e.data.uid);
        if (e.data?.kinWorkflow === "detach") ports.delete(port);
      });
    },
    async request(
      request: WorkflowRequest,
      signal: AbortSignal,
    ): Promise<unknown> {
      signal.throwIfAborted();
      const candidates = [...ports]
        .filter(([, uid]) => uid === request.spec.ownerId)
        .map(([port]) => port)
        .reverse();
      for (const port of candidates) {
        try {
          await exchange(
            port,
            { kinWorkflowPing: request.spec.ownerId },
            signal,
            1500,
          );
          return await exchange(
            port,
            { request },
            signal,
            request.operation === "startup" ? 25000 : 20000,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof WorkflowUnavailableError)) throw error;
          ports.delete(port);
          // Replays are safe: commits are fenced and content-addressed, saves use a stable version ID,
          // and startup previews have temporary records. A lost acknowledgement is not a success.
        }
      }
      throw new WorkflowUnavailableError(
        "Awaiting an authenticated Kin tab. Resume when it is open.",
      );
    },
  };
}
