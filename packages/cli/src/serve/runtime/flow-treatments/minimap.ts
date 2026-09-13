import { baseCss } from "./base.js";
import { mountMap } from "./maps.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="minimap"] [data-pyric-flow] {
  outline-width: 1px;
}`,
  mount: (context) => mountMap(context, "minimap"),
} satisfies FlowTreatment;
