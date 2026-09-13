import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="echo"] [data-pyric-flow]::before {
  content: "";
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--pyric-treatment-ink) 50%, transparent),
    0 0 0 6px color-mix(in srgb, var(--pyric-treatment-ink) 30%, transparent),
    0 0 0 10px color-mix(in srgb, var(--pyric-treatment-ink) 12%, transparent);
  animation: pyric-treatment-echo 1.5s ease-out both;
}
@keyframes pyric-treatment-echo {
  to {
    transform: scale(1.03, 1.08);
    opacity: 0;
  }
}
html[data-pyric-treatment="echo"]

  [data-pyric-flow-retained]::before {
  content: none;
}`,
} satisfies FlowTreatment;
