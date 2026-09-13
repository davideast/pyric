import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="wash"] [data-pyric-flow] {
  box-shadow: inset 0 0 0 100vmax color-mix(in srgb, var(--pyric-treatment-ink) 9%, transparent);
}
html[data-pyric-treatment="wash"] [data-pyric-flow-retained] {
  box-shadow: none;
}`,
} satisfies FlowTreatment;
