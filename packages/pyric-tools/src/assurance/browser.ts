import type { AssuranceVisualizationSnapshot } from "./types.js";

export const ASSURANCE_BROWSER_EVENT = "pyric:assurance-campaign";
export const ASSURANCE_BROADCAST_CHANNEL = "pyric-assurance-v1";

const listeners = new Set<(snapshot: AssuranceVisualizationSnapshot) => void>();
let installed = false;
let channel: BroadcastChannel | undefined;

function receive(snapshot: AssuranceVisualizationSnapshot): void {
  for (const listener of listeners) listener(snapshot);
}

function isSnapshot(value: unknown): value is AssuranceVisualizationSnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { schema?: unknown }).schema ===
      "pyric.assurance.visualization.v1" &&
    typeof (value as { campaignId?: unknown }).campaignId === "string"
  );
}

function installBrowserReceivers(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  globalThis.addEventListener(ASSURANCE_BROWSER_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isSnapshot(detail)) receive(detail);
  });
  try {
    channel = new BroadcastChannel(ASSURANCE_BROADCAST_CHANNEL);
    channel.onmessage = (event) => {
      if (isSnapshot(event.data)) receive(event.data);
    };
  } catch {
    // BroadcastChannel is optional in constrained browser contexts.
  }
}

export function subscribeAssuranceVisualizations(
  listener: (snapshot: AssuranceVisualizationSnapshot) => void,
): () => void {
  installBrowserReceivers();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishAssuranceVisualization(
  snapshot: AssuranceVisualizationSnapshot,
): void {
  receive(snapshot);
  const globalKind =
    (globalThis as { constructor?: { name?: string } }).constructor?.name ?? "";
  const isBrowserWorker = globalKind.endsWith("WorkerGlobalScope");
  if (typeof document !== "undefined") {
    try {
      globalThis.dispatchEvent(
        new CustomEvent<AssuranceVisualizationSnapshot>(
          ASSURANCE_BROWSER_EVENT,
          {
            detail: snapshot,
          },
        ),
      );
    } catch {
      // Visualization delivery is observational; campaign execution already succeeded.
    }
  }
  if (typeof document === "undefined" && !isBrowserWorker) return;
  try {
    const target = channel ?? new BroadcastChannel(ASSURANCE_BROADCAST_CHANNEL);
    target.postMessage(snapshot);
    if (target !== channel) target.close();
  } catch {
    // BroadcastChannel is optional (SSR and constrained browser contexts).
  }
}

export type { AssuranceVisualizationSnapshot } from "./types.js";
