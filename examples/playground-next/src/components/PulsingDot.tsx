/**
 * Animated dot — "live / streaming" indicator. Ported from jules.ink.
 */
export function PulsingDot({ color = '#19cc61' }: { color?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span
        className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
        style={{ background: color }}
      />
      <span
        className="relative inline-flex rounded-full h-2 w-2"
        style={{ background: color }}
      />
    </span>
  );
}
