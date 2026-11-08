/**
 * Format an unknown thrown value into a concise diagnostic string.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
