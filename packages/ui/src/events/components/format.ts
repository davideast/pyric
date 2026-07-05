/**
 * Default `when`-column formatter: a session-relative duration
 * (`now` / `12s` / `3m` / `1h`), matching the mock's `c-when` strings.
 * The grid is session-scoped (see design-ideation "FRAME CORRECTION")
 * so anchors are relative, never absolute calendar dates.
 *
 * Override via `<ActivityGrid formatWhen={...} />` when the host has a
 * better clock anchor (e.g. a ticking "session now").
 */
export function defaultFormatWhen(at: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - at);
  const s = Math.floor(deltaMs / 1000);
  if (s < 1) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
