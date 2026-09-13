/** Browser-side extension contract. Implementations run as application code. */
export interface FlowTreatmentMetadata {
  id: string;
  name: string;
  description: string;
  group: "Standard" | "Experimental" | "Custom";
}
export interface FlowTreatmentRecord {
  sequence: number;
  listenerId: string;
  label: string;
  target: string;
  elements: readonly HTMLElement[];
}
export interface FlowTreatmentContext {
  document: Document;
  container: HTMLElement;
  /** Last five observed paints, pruned as targets disappear or are hidden. */
  history(): readonly FlowTreatmentRecord[];
}
export interface FlowTreatmentInstance {
  update(): void;
  dispose(): void;
}
export interface FlowTreatment {
  /** Scope rules with html[data-pyric-treatment="your-id"]. */
  css: string;
  mount?(context: FlowTreatmentContext): FlowTreatmentInstance;
}
export interface FlowTreatmentManifest {
  treatment?: string;
  treatments: Array<FlowTreatmentMetadata & { url: string }>;
}
export interface FlowTreatmentState {
  selected: string;
  loading: string | null;
  error: string | null;
  retry: string | null;
  choices: readonly FlowTreatmentMetadata[];
}
