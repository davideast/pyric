/**
 * The message `run` throws, or null when it returns. The simulator reuses the
 * SDK's throwing validators and reports what they throw as a reason.
 */
export function thrownMessage(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
