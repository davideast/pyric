import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="rail"] [data-pyric-flow] {
  outline: 0;
  box-shadow: inset 3px 0 var(--pyric-treatment-ink);
}
html[data-pyric-treatment="rail"] [data-pyric-flow-retained] {
  box-shadow: inset 1px 0 color-mix(in srgb, var(--pyric-treatment-ink) 45%, transparent);
}`,
} satisfies FlowTreatment;
