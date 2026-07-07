/**
 * User-facing duration formatter. Raw `ms` reads fine for short ops
 * (`240ms`) but `81397ms` is parsed by the eyes as "eighty-thousand
 * milliseconds" before the brain catches up — seconds are what humans
 * think in past one second.
 *
 *   < 1000 ms                    → `240ms`
 *   1s up to 60s, < 10s          → `2.4s`         (one decimal)
 *   1s up to 60s, >= 10s         → `42s`          (whole seconds)
 *   60s and up                   → `1m 21s`       (`1m` if seconds=0)
 *
 * One formatter for every visible duration in the app so the
 * threshold and rounding stay consistent.
 *
 * Agent-facing strings (`runOnce` summary returned to the model) keep
 * raw `ms` on purpose — the model wants exact numbers, not a
 * formatted display.
 */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, ms);
  if (abs < 1000) return `${Math.round(abs)}ms`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(abs / 60_000);
  const s = Math.round((abs - m * 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
