/**
 * Default `HH:MM:SS` timestamp formatter. Components accept a
 * `formatTime` prop to override — this is just the fallback so the
 * library has no hard locale dependency.
 */
export function defaultFormatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Classifies a simulator debug line as a deny / allow / neutral
 * verdict so consumers can tint reason rows via
 * `[data-pyric-reason-verdict="…"]`.
 */
export function reasonVerdict(reason: string): 'deny' | 'allow' | 'neutral' {
  const lower = reason.toLowerCase();
  if (lower.includes('deny')) return 'deny';
  if (lower.includes('allow')) return 'allow';
  return 'neutral';
}
