import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="corners"] [data-pyric-flow] {
  outline: 0;
}
html[data-pyric-treatment="corners"] [data-pyric-flow]::before {
  content: "";
  background:
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) top left/12px 2px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) top left/2px 12px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) top right/12px 2px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) top right/2px 12px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) bottom left/12px 2px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) bottom left/2px 12px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) bottom right/12px 2px no-repeat,
    linear-gradient(var(--pyric-treatment-ink), var(--pyric-treatment-ink)) bottom right/2px 12px no-repeat;
}`,
} satisfies FlowTreatment;
