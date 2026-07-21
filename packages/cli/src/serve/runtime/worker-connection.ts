import type { ClientDb } from '../worker/client/handles.js';

/** Construct the control connection without letting a browser policy failure abort runtime boot. */
export function connectRuntimeWorker(
  connect: () => ClientDb,
  reportError: (error: unknown) => void,
): ClientDb | null {
  try {
    return connect();
  } catch (error) {
    reportError(error);
    return null;
  }
}
