export interface PulsingDotProps {
  /** Forwarded to the outer wrapper. Consumers attach all visual
   *  styling (size, animation, color) via this hook or by selecting
   *  on `[data-pyric-ui="pulsing-dot"]`. */
  className?: string;
}

/**
 * Headless "live / streaming" indicator. Ships zero visual styling.
 *
 * Renders three nested spans so consumers can style ring + core
 * independently:
 *
 *   <span data-pyric-ui="pulsing-dot">
 *     <span data-pyric-pulse-ring />
 *     <span data-pyric-pulse-core />
 *   </span>
 *
 * Animation, color, and size are entirely consumer-defined.
 */
export function PulsingDot({ className }: PulsingDotProps) {
  return (
    <span data-pyric-ui="pulsing-dot" className={className}>
      <span data-pyric-pulse-ring aria-hidden="true" />
      <span data-pyric-pulse-core aria-hidden="true" />
    </span>
  );
}
