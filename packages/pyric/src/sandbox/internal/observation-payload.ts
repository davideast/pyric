/** Diagnostic previews are bounded JSON snapshots without rewriting field names or values. */
export function observationPayload(value: unknown, limit = 16384): { text: string; truncated: boolean } | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) return;
    return { text: text.slice(0, limit), truncated: text.length > limit };
  } catch {
    return;
  }
}
