import { diagnostic, diagnosticSettings } from "../../diagnostics/remote-diagnostics";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../../data";
import { handleWorkflowRequest } from "./build-tab-services";
import {
  connectJobEngine,
  type ConnectedJobEngine,
} from "@inbrowser/resumable";
import { readPyricRuntimeManifest } from "../../../../../packages/cli/src/serve/runtime/manifest";
import { workerNameForEpoch } from "../../../../../packages/cli/src/serve/runtime/worker-generation";
import type { DurableGeneration, GenerationSpec } from "./generation-types";
let client: ConnectedJobEngine<DurableGeneration, GenerationSpec> | undefined;
let port: MessagePort;
export function generationClient() {
  if (client) return client;
  if (typeof SharedWorker === "undefined")
    throw new Error(
      "Resumable builds require SharedWorker support. Open Kin in a browser that supports SharedWorker.",
    );
  const worker = new SharedWorker(
    new URL("./generation-shared-worker.ts", import.meta.url),
    {
      // New protocol revision prevents an open tab from reusing the old planner.
      // The durable IDB store is unchanged, so drafts and activity remain available.
      name: "kin-generation-workflow-v3",
      type: "module",
      extendedLifetime: true,
    } as WorkerOptions & { extendedLifetime: boolean },
  );
  port = worker.port;
  port.start();
  port.postMessage({kinDiagnostics: diagnosticSettings()});
  diagnostic("worker-connected");
  let session = new AbortController();
  onAuthStateChanged(auth, (user) => {
    session.abort();
    session = new AbortController();
    port.postMessage(
      user
        ? { kinWorkflow: "attach", uid: user.uid }
        : { kinWorkflow: "detach" },
    );
  });
  port.addEventListener("message", async (event) => {
    if (!event.data?.kinWorkflowRequest) return;
    const id = event.data.kinWorkflowRequest;
    if (event.data.kinWorkflowPing) {
      if (auth.currentUser?.uid === event.data.kinWorkflowPing)
        port.postMessage({ kinWorkflowReply: id, value: true });
      return;
    }
    const signal = session.signal;
    try {
      const value = await handleWorkflowRequest(event.data.request, signal);
      signal.throwIfAborted();
      port.postMessage({ kinWorkflowReply: id, value });
    } catch (error) {
      port.postMessage({ kinWorkflowReply: id, error: String(error) });
    }
  });
  window.addEventListener("pagehide", () => {
    diagnostic("page-hidden");
    port.postMessage({ kinWorkflow: "detach" });
  });
  window.addEventListener("pageshow", () => diagnostic("page-shown"));
  if (auth.currentUser)
    port.postMessage({ kinWorkflow: "attach", uid: auth.currentUser.uid });
  const runtime = readPyricRuntimeManifest();
  const backend = new SharedWorker(runtime.worker.url, {
    name: workerNameForEpoch(runtime.worker.servedEpoch, localStorage),
    type: "classic",
  });
  // Transfer a fresh connection, never the page's active Firebase port.
  port.postMessage({ kinControl: "attach-ai" }, [backend.port]);
  client = connectJobEngine<DurableGeneration, GenerationSpec>(port);
  return client;
}
export async function generationControl(
  kinControl: "active" | "cancel" | "retire",
  jobId: string,
): Promise<boolean> {
  generationClient();
  const rid = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.kinReply === rid) {
        clearTimeout(timer);
        port.removeEventListener("message", listener);
        resolve(event.data.value);
      }
    };
    const timer = setTimeout(() => {
      port.removeEventListener("message", listener);
      reject(
        new Error("The build worker did not respond. Reload to reconnect."),
      );
    }, 10000);
    port.addEventListener("message", listener);
    port.postMessage({ kinControl, rid, jobId });
  });
}
