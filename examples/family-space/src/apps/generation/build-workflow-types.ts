import type { GenerationSpec } from "./generation-types";
import type { PolicySelection } from "../policies/generation-policy-tools";
import type { KitSelection } from "../ui-kit/ui-kit-selection";

export const workflowCompatibility = {
  workflow: 1,
  runtime: 1,
  policy: "kin-authored-1",
  ui: 1,
} as const;
export type BuildStage =
  | "plan"
  | "policy-source"
  | "policy-cases"
  | "policy-check"
  | "ui"
  | "code"
  | "compile"
  | "startup"
  | "save"
  | "done";
export type BuildStatus =
  | "running"
  | "interrupted"
  | "awaiting-tab"
  | "needs-attention"
  | "cancelled"
  | "ready";
export type PermissionPlan = {
  mode: "authored" | "chore-quest-v1" | "family-trust" | "unsupported";
  summary: string;
  requirements: string[];
  recordSchema?: Record<string, string>;
  modules: string[];
  capabilities: string[];
};
export type WorkflowState = {
  format: 1;
  compatibility: {
    workflow: number;
    runtime: number;
    policy: string;
    ui: number;
  };
  spec: GenerationSpec;
  stage: BuildStage;
  status: BuildStatus;
  files: Record<string, string>;
  responses: Partial<Record<BuildStage, string>>;
  attempts: Partial<Record<BuildStage, number>>;
  attemptGroup: number;
  diagnostic?: string;
  inflight?: BuildStage;
  plan?: PermissionPlan;
  policy?: PolicySelection;
  ui?: KitSelection;
  startupPassed?: boolean;
};
export type BuildLease = { executor: string; token: string; expiresAt: number };
export type RestoredBuild = {
  state: WorkflowState;
  revision: number;
  checkpointId: string;
};
export function initialWorkflow(spec: GenerationSpec): WorkflowState {
  const { workflow: _, previous: __, ...input } = spec;
  return {
    format: 1,
    compatibility: workflowCompatibility,
    spec: input,
    stage: "plan",
    status: "running",
    files: {},
    responses: {},
    attempts: {},
    attemptGroup: 0,
  };
}

export class WorkflowUnavailableError extends Error {}
