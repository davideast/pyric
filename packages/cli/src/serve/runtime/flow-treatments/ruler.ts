import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="ruler"] [data-pyric-flow] {
  outline-offset: 7px;
  outline-style: dotted;
}
html[data-pyric-treatment="ruler"]

  [data-pyric-flow-label]::after {
  content: attr(data-pyric-flow-size) " px / " attr(data-pyric-flow-name);
  top: -19px;
}
html[data-pyric-treatment="ruler"] [data-pyric-flow]::before {
  content: "";
  inset: -8px;
  border-top: 1px solid var(--pyric-treatment-ink);
  border-bottom: 1px solid var(--pyric-treatment-ink);
  background:
    repeating-linear-gradient(90deg, var(--pyric-treatment-ink) 0 1px, transparent 1px 10px)
      top/100% 4px no-repeat,
    repeating-linear-gradient(90deg, var(--pyric-treatment-ink) 0 1px, transparent 1px 10px)
      bottom/100% 4px no-repeat;
}
html[data-pyric-treatment="ruler"] [data-pyric-flow-badge] { font-size: 0; }
html[data-pyric-treatment="ruler"] [data-pyric-flow-badge]::after {
  content: attr(data-pyric-flow-size) " px / " attr(data-pyric-flow-name);
  font: 10px/20px var(--pyric-overlay-badge-font-family);
}
`,
} satisfies FlowTreatment;
