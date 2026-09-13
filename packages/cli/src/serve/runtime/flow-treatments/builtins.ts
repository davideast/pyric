import type { FlowTreatment } from "./types.js";
export const builtinLoaders: Record<
  string,
  () => Promise<{ default: FlowTreatment }>
> = {
  outline: () => import("./outline.js"),
  wash: () => import("./wash.js"),
  rail: () => import("./rail.js"),
  corners: () => import("./corners.js"),
  label: () => import("./label.js"),
  radar: () => import("./radar.js"),
  scan: () => import("./scan.js"),
  ants: () => import("./ants.js"),
  echo: () => import("./echo.js"),
  heat: () => import("./heat.js"),
  stamp: () => import("./stamp.js"),
  ruler: () => import("./ruler.js"),
  threads: () => import("./threads.js"),
  trail: () => import("./trail.js"),
  minimap: () => import("./minimap.js"),
};
