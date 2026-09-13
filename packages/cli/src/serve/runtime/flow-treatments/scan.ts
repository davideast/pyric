import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="scan"] [data-pyric-flow]::before {
  content: "";
  background: linear-gradient(
      transparent,
      color-mix(in srgb, var(--pyric-treatment-ink) 25%, transparent),
      var(--pyric-treatment-ink),
      transparent
    )
    0 -24px/100% 24px no-repeat;
  animation: pyric-treatment-scan 1.4s ease-out both;
}
@keyframes pyric-treatment-scan {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 0 calc(100% + 24px);
  }
}
html[data-pyric-treatment="scan"]

  [data-pyric-flow-retained]::before {
  content: none;
}`,
} satisfies FlowTreatment;
