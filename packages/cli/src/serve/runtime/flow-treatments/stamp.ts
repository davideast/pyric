import { baseCss } from "./base.js";
import type { FlowTreatment } from "./types.js";
export default {
  css:
    baseCss +
    `html[data-pyric-treatment="stamp"]
 
  [data-pyric-flow-label]::after {
  content: "#" attr(data-pyric-flow-sequence) " / " attr(data-pyric-flow-name) " / "
    attr(data-pyric-flow-hits) " hits";
  height: 22px;
  border-radius: 2px;
  border-style: dashed;
  transform: rotate(-1deg);
  color: #e3ecfa;
}
html[data-pyric-treatment="stamp"] [data-pyric-flow-badge] { font-size: 0; }
html[data-pyric-treatment="stamp"] [data-pyric-flow-badge]::after {
  content: "#" attr(data-pyric-flow-sequence) " / " attr(data-pyric-flow-name) " / " attr(data-pyric-flow-hits) " hits";
  font: 10px/20px var(--pyric-overlay-badge-font-family);
}
`,
} satisfies FlowTreatment;
