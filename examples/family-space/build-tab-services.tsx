import React from "react";
import { createRoot } from "react-dom/client";
import { AppPreview } from "./app-preview";
import { auth, db, base } from "./data";
import { createBuildRepository } from "./build-repository";
import { saveGeneratedVersion } from "./app-versions";
import type { WorkflowRequest } from "./workflow-bridge";
import type { WorkflowState } from "./build-workflow-types";
export const buildRepository = createBuildRepository({
  db,
  base,
  uid: () => auth.currentUser?.uid ?? null,
});
export function workflowCandidate(state: WorkflowState) {
  return {
    id: state.spec.id,
    ownerId: state.spec.ownerId,
    title: state.spec.title,
    prompt: state.spec.prompt,
    context: state.spec.context,
    audience: state.spec.audience,
    createdAt: state.spec.createdAt,
    published: false,
    source: state.files["/work/App.tsx"],
    ...(state.policy?.policy
      ? { policy: state.policy.policy, policyRequired: true }
      : {}),
  };
}
export function checkCandidateStartup(
  state: WorkflowState,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const element = document.createElement("div");
    element.setAttribute("aria-hidden", "true");
    // Keep a real layout viewport for React startup; this is never a live-data preview.
    Object.assign(element.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1024px",
      height: "768px",
      pointerEvents: "none",
    });
    document.body.append(element);
    const root = createRoot(element);
    let settling: ReturnType<typeof setTimeout> | undefined,
      finished = false;
    const cleanup = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(settling);
      signal.removeEventListener("abort", abort);
      queueMicrotask(() => {
        root.unmount();
        element.remove();
      });
      error ? reject(error) : resolve();
    };
    const abort = () => cleanup(Error("Preview session ended."));
    const timeout = setTimeout(
      () => cleanup(Error("The app did not become ready within 15 seconds.")),
      15000,
    );
    signal.addEventListener("abort", abort, { once: true });
    root.render(
      <AppPreview
        appId={state.spec.id}
        source={state.files["/work/App.tsx"]}
        context={state.spec.context}
        isolated
        policy={state.policy?.policy}
        policyRequired={!!state.policy?.policy}
        onError={(message) => cleanup(Error(message))}
        onHealth={(health) => {
          if (health === "healthy" && !settling) {
            clearTimeout(timeout);
            settling = setTimeout(() => cleanup(), 2000);
          }
        }}
      />,
    );
  });
}
export async function handleWorkflowRequest(
  request: WorkflowRequest,
  signal: AbortSignal,
) {
  const { spec, state, operation } = request;
  signal.throwIfAborted();
  if (auth.currentUser?.uid !== spec.ownerId || !spec.workflow)
    throw Error("Build identity is no longer available.");
  const lease = spec.workflow.lease;
  if (operation === "renew") return buildRepository.renew(spec, lease);
  if (operation === "release")
    return buildRepository.release(spec, lease, state?.status);
  await buildRepository.renew(spec, lease);
  if (!state) throw Error("Missing workflow checkpoint.");
  if (operation === "checkpoint")
    return buildRepository.commit(spec, lease, request.revision!, state);
  if (operation === "startup") {
    await checkCandidateStartup(state, signal);
    signal.throwIfAborted();
    return;
  }
  if (operation === "save") {
    if (!state.startupPassed || state.stage !== "save")
      throw Error("Candidate validation is incomplete.");
    signal.throwIfAborted();
    return saveGeneratedVersion(
      { ...spec, policyWorkflow: 1, policySelection: state.policy },
      workflowCandidate(state),
    );
  }
  throw Error("Unsupported workflow operation.");
}
