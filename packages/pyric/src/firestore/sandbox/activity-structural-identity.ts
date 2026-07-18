/** Canonical internal identity for trusted, already-projected activity data. */
export function activityStructuralIdentity(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => activityStructuralIdentity(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${activityStructuralIdentity(record[key])}`,
  ).join(',')}}`;
}
