export const baseCss = `html[data-pyric-treatment] [data-pyric-flow] {
  --pyric-treatment-ink: var(--pyric-overlay-hue, #90b8ff);
  outline: var(--pyric-overlay-flow-outline-width) var(--pyric-overlay-outline-style) var(--pyric-treatment-ink);
  outline-offset: 3px;
  border-radius: var(--pyric-overlay-radius);
  animation: none;
  transition: outline-color 1.2s ease-out;
}
html[data-pyric-treatment] [data-pyric-flow-retained] {
  outline-color: color-mix(in srgb, var(--pyric-treatment-ink) 35%, transparent);
}
html[data-pyric-treatment] [data-pyric-flow-label]::after {
  all: unset;
  box-sizing: border-box;
  content: attr(data-pyric-flow-label);
  position: absolute;
  top: -12px;
  right: 4px;
  z-index: 50;
  display: grid;
  align-items: center;
  height: 20px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--pyric-overlay-badge-bg);
  color: var(--pyric-treatment-ink);
  border: 1px solid var(--pyric-treatment-ink);
  border-radius: 4px;
  font:
    var(--pyric-overlay-leaf-badge-font-size)/20px var(--pyric-overlay-badge-font-family);
  pointer-events: none;
  opacity: 1;
}
html[data-pyric-treatment] [data-pyric-flow-retained]::after {
  opacity: 0.6;
}
html[data-pyric-treatment] [data-pyric-flow]::before {
  content: none;
  position: absolute;
  inset: -4px;
  border-radius: var(--pyric-overlay-radius);
  pointer-events: none;
  z-index: 40;
}
html[data-pyric-treatment] [data-pyric-flow-retained]::before {
  animation: none;
  opacity: 0.3;
}
.pyric-treatment-flow-map {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.pyric-treatment-flow-map text {
  font:
    10px "Pyric Geist Mono",
    monospace;
  fill: #e0eaff;
}
@media (prefers-reduced-motion: reduce) {
  html[data-pyric-treatment] [data-pyric-flow],
  html[data-pyric-treatment] [data-pyric-flow]::before,
  html[data-pyric-treatment] [data-pyric-flow]::after {
    animation: none !important;
    transition: none !important;
  }
}
html[data-pyric-treatment] [data-pyric-listener-overlay] [data-pyric-flow-badge] {
 display: grid; align-items: center; height: 20px; max-width: 240px;
 overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
 font: var(--pyric-overlay-leaf-badge-font-size)/20px var(--pyric-overlay-badge-font-family);
 border-radius: 4px; background: var(--pyric-overlay-badge-bg);
}
html[data-pyric-treatment] [data-pyric-flow-badge][data-pyric-flow-retained] { opacity: .6; }`;
