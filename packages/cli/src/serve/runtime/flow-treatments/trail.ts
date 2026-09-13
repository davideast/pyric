import { baseCss } from "./base.js";
import { mountMap } from "./maps.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="trail"] [data-pyric-flow] {
  outline-style: dashed;
  outline-width: 1px;
}`,
  mount: (context) => mountMap(context, "trail"),
} satisfies FlowTreatment;
