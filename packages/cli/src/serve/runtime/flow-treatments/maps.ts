import type { FlowTreatmentContext, FlowTreatmentInstance } from "./types.js";

/** Geometry is supplied by the shared overlay lifecycle, including nested scroll. */
export function mountMap(
  context: FlowTreatmentContext,
  kind: "threads" | "trail" | "minimap",
): FlowTreatmentInstance {
  const { document, container } = context;
  const node = (name: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, String(value));
    return el;
  };
  const svg = node("svg", {
    class: "pyric-treatment-flow-map",
    "aria-hidden": "true",
  });
  container.append(svg);
  const text = (x: number, y: number, value: string) => {
    const el = node("text", { x, y });
    el.textContent = value;
    svg.append(el);
  };
  return {
    update() {
      svg.replaceChildren();
      const history = context.history();
      const latest = history.at(-1);
      if (!latest) return;
      const active = latest.elements;
      const color =
        document.defaultView
          ?.getComputedStyle(active[0]!)
          .getPropertyValue("--pyric-overlay-hue")
          .trim() || "#91baff";
      if (kind === "threads") {
        // A delivery need not originate from an on-page click. This labeled
        // origin represents the listener, not an invented application element.
        const first = active[0]!.getBoundingClientRect();
        const x = Math.max(12, first.left),
          y = Math.max(28, first.top - 32);
        text(x, y - 8, `${latest.label}: ${latest.target}`);
        for (const element of active) {
          const r = element.getBoundingClientRect();
          svg.append(
            node("path", {
              d: `M ${x} ${y} C ${x} ${y + 24}, ${r.left - 16} ${r.top - 24}, ${r.left} ${r.top}`,
              fill: "none",
              stroke: color,
              "stroke-width": 1.5,
              opacity: 0.7,
            }),
          );
        }
      } else if (kind === "trail") {
        const points = history.map((entry, i) => {
          const r = entry.elements[0]!.getBoundingClientRect();
          return {
            x: r.right - 8 + i * 3,
            y: r.top + 8 + i * 3,
            sequence: entry.sequence,
          };
        });
        svg.append(
          node("polyline", {
            points: points.map((p) => `${p.x},${p.y}`).join(" "),
            fill: "none",
            stroke: color,
            "stroke-dasharray": "3 5",
          }),
        );
        for (const p of points) {
          svg.append(
            node("circle", {
              cx: p.x,
              cy: p.y,
              r: 11,
              fill: "#151d2a",
              stroke: color,
            }),
          );
          text(p.x - 4, p.y + 3, String(p.sequence));
        }
      } else {
        const elements = [
          ...new Set(history.flatMap((entry) => [...entry.elements])),
        ];
        const rects = elements.map((el) => el.getBoundingClientRect());
        const left = Math.min(...rects.map((r) => r.left)),
          top = Math.min(...rects.map((r) => r.top));
        const width = Math.max(
          1,
          Math.max(...rects.map((r) => r.right)) - left,
        );
        const height = Math.max(
          1,
          Math.max(...rects.map((r) => r.bottom)) - top,
        );
        const scale = Math.min(160 / width, 140 / height),
          x = 16,
          y = 44;
        svg.append(
          node("rect", {
            x: 8,
            y: 16,
            width: width * scale + 16,
            height: height * scale + 36,
            rx: 5,
            fill: "#101723",
            stroke: "#5f718a",
          }),
        );
        text(x, 32, "OBSERVED REGIONS");
        rects.forEach((r, i) =>
          svg.append(
            node("rect", {
              x: x + (r.left - left) * scale,
              y: y + (r.top - top) * scale,
              width: Math.max(2, r.width * scale),
              height: Math.max(2, r.height * scale),
              fill: active.includes(elements[i]!) ? color : "#222e40",
              stroke: "#7385a1",
              "stroke-width": 0.4,
              opacity: 0.8,
            }),
          ),
        );
      }
    },
    dispose() {
      svg.remove();
    },
  };
}
