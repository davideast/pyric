import type { FlowTreatmentManifest } from "./runtime/flow-treatments/types.js";
import { builtinTreatments } from "./runtime/flow-treatments/catalog.js";

/** JSON project configuration; module paths resolve from the project root. */
export interface FlowConfig {
  treatment?: string;
  treatments?: Array<{
    id: string;
    label: string;
    description?: string;
    module: string;
  }>;
}
export function resolveFlowConfig(
  base: unknown,
  overrides?: FlowConfig,
): FlowConfig {
  const config = { ...validate(base), ...validate(overrides) };
  const ids = new Set(builtinTreatments.map((entry) => entry.id as string));
  for (const entry of config.treatments ?? []) {
    if (ids.has(entry.id))
      throw new Error(`pyric.json flow: duplicate treatment id "${entry.id}"`);
    ids.add(entry.id);
  }
  if (config.treatment && !ids.has(config.treatment))
    throw new Error(
      `pyric.json flow: unknown default treatment "${config.treatment}"`,
    );
  return config;
}
function validate(value: unknown): FlowConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("pyric.json flow must be an object");
  const config = value as FlowConfig;
  if (config.treatment !== undefined && typeof config.treatment !== "string")
    throw new Error("pyric.json flow.treatment must be a treatment id");
  if (config.treatments !== undefined) {
    if (!Array.isArray(config.treatments))
      throw new Error("pyric.json flow.treatments must be an array");
    for (const entry of config.treatments) {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !/^[a-z0-9-]+:[a-z0-9-]+$/.test(entry.id) ||
        typeof entry.label !== "string" ||
        !entry.label.trim() ||
        typeof entry.module !== "string" ||
        !entry.module.trim() ||
        (entry.description !== undefined &&
          typeof entry.description !== "string")
      )
        throw new Error(
          "pyric.json flow.treatments entries require a namespaced id, label, and module path",
        );
    }
  }
  return config;
}
export function flowManifest(config: FlowConfig): FlowTreatmentManifest {
  return {
    treatment: config.treatment ?? "outline",
    treatments: (config.treatments ?? []).map((entry) => ({
      id: entry.id,
      name: entry.label,
      description: entry.description ?? "",
      group: "Custom",
      url: `/__pyric/flow/custom/${encodeURIComponent(entry.id)}.js`,
    })),
  };
}
