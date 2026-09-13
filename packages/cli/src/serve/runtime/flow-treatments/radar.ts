import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="radar"] [data-pyric-flow]::before {
  content: "";
  border: 1px solid var(--pyric-treatment-ink);
  animation: pyric-treatment-radar 1.1s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes pyric-treatment-radar {
  from {
    transform: scale(1);
    opacity: 0.8;
  }
  to {
    transform: scale(1.07, 1.2);
    opacity: 0;
  }
}
html[data-pyric-treatment="radar"]
 
  [data-pyric-flow-retained]::before {
  content: none;
}`,
} satisfies FlowTreatment;
