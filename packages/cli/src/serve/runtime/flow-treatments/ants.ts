import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="ants"] [data-pyric-flow] {
  outline: 0;
}
html[data-pyric-treatment="ants"] [data-pyric-flow]::before {
  content: "";
  background:
    repeating-linear-gradient(90deg, var(--pyric-treatment-ink) 0 5px, transparent 5px 10px)
      top/200% 1px no-repeat,
    repeating-linear-gradient(90deg, var(--pyric-treatment-ink) 0 5px, transparent 5px 10px)
      bottom/200% 1px no-repeat,
    repeating-linear-gradient(0deg, var(--pyric-treatment-ink) 0 5px, transparent 5px 10px)
      left/1px 200% no-repeat,
    repeating-linear-gradient(0deg, var(--pyric-treatment-ink) 0 5px, transparent 5px 10px)
      right/1px 200% no-repeat;
  animation: pyric-treatment-ants 1.6s linear both;
}
@keyframes pyric-treatment-ants {
  to {
    background-position:
      10px top,
      -10px bottom,
      left 10px,
      right -10px;
  }
}`,
} satisfies FlowTreatment;
