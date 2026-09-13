import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="label"] [data-pyric-flow] {
  outline: 0;
}`,
} satisfies FlowTreatment;
