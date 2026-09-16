/** Diagnostic previews are bounded and omit credential fields at every depth. */
const secretField = /password|credential|secret|token|authorization|cookie|api[-_]?key/i;
export function observationText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/((?:password|api[-_]?key|access[-_]?token|refresh[-_]?token|secret)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[redacted]');
}
export function observationPayload(value: unknown, limit = 16384): { text: string; truncated: boolean } | undefined {
  try {
    const text = JSON.stringify(value, (key, item) => {
      if (secretField.test(key)) return '[redacted]';
      return typeof item === 'string' ? observationText(item) : item;
    }, 2);
    if (text === undefined) return;
    return { text: text.slice(0, limit), truncated: text.length > limit };
  } catch { return; }
}
