import type { UiKit } from "./ui-kit";
import type { KitSelection } from "./ui-kit-selection";
export type FamilyApp = {
  policyRequired?: boolean;
  policy?: import("./app-policy").Policy | null;
  id: string;
  ownerId: string;
  title: string;
  prompt: string;
  source: string;
  context: string;
  audience: string[];
  createdAt: number;
  published: boolean;
  activeVersionId?: string | null;
  versionCount?: number;
  deletedAt?: number | null;
};
export type GenerationEvent = {
  id: number;
  kind: "context" | "summary" | "response" | "tool" | "result" | "error";
  title: string;
  detail: string;
  running: boolean;
};
export type GenerationJob = {
  canResume?: boolean;
  versionId?: string;
  id: string;
  ownerId: string;
  title: string;
  state:
    | "running"
    | "ready"
    | "failed"
    | "stopped"
    | "interrupted"
    | "awaiting-tab";
  events: GenerationEvent[];
  draft?: FamilyApp;
  error?: string;
};
export type GenerationSpec = {
  workflow?: {
    lease: import("./build-workflow-types").BuildLease;
    revision: number;
    state: import("./build-workflow-types").WorkflowState;
  };
  modelConfig?: {
    model: string;
    systemInstruction: string;
    generationConfig: { temperature: number; maxOutputTokens: number };
  };
  expectedActiveVersionId?: string | null;
  policyWorkflow?: 1;
  requiredPolicy?: import("./app-policy").Policy | null;
  policySelection?: import("./generation-policy-tools").PolicySelection;
  baseSource?: string;
  buildId?: string;
  draftRevision?: number;
  baseVersionId?: string | null;
  id: string;
  ownerId: string;
  title: string;
  prompt: string;
  context: string;
  audience: string[];
  createdAt: number;
  // Only completed model output is a checkpoint. Partial tokens are never treated as source.
  repair?: { source: string; error: string; revision: string };
  uiKit?: UiKit;
  uiSelection?: KitSelection;
  checkpoint?: string;
  previous?: GenerationJob;
};
export type DurableGeneration = { job: GenerationJob; spec: GenerationSpec };
