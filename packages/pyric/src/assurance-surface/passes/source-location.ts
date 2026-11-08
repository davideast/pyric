/**
 * Shared browser-clean source-location parsing and formatting helpers for
 * assurance-surface index passes.
 */

export function splitSourceLocation(source: string): { file: string; line: number | undefined } {
  const colon = source.lastIndexOf(':');
  if (colon <= 0) {
    return { file: source, line: undefined };
  }
  const parsed = Number(source.slice(colon + 1));
  let line: number | undefined;
  if (Number.isInteger(parsed) && parsed > 0) {
    line = parsed;
  }
  return { file: source.slice(0, colon), line };
}

export function formatSourceAtLine(line: number | undefined): string {
  if (line === undefined) return '';
  return ` at line ${line}`;
}
