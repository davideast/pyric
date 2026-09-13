import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="heat"] [data-pyric-flow] {
  --pyric-treatment-ink: hsl(var(--pyric-flow-heat, 210) 85% 68%);
  box-shadow: inset 0 0 0 100vmax hsl(var(--pyric-flow-heat, 210) 75% 50% / 0.12);
  outline-width: 2px;
}
html[data-pyric-treatment="heat"]

  [data-pyric-flow-label]::after {
  content: attr(data-pyric-flow-hits) " observed updates";
}
html[data-pyric-treatment="heat"] [data-pyric-flow-badge] { font-size: 0; }
html[data-pyric-treatment="heat"] [data-pyric-flow-badge]::after {
  content: attr(data-pyric-flow-hits) " observed updates";
  font: 10px/20px var(--pyric-overlay-badge-font-family);
}
`,
} satisfies FlowTreatment;
