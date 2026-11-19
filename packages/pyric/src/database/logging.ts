/**
 * Process-scoped RTDB client SDK logger state mirroring `firebase/database`'s
 * `enableLogging(logger?, persistent?)`.
 */

type ClientDatabaseLogSink = (message: string) => void;

const PERSISTENT_CUSTOM_LOGGER_ERROR =
  "FIREBASE INTERNAL ASSERT FAILED: Can't turn on custom loggers persistently.";

let activeLogSink: ClientDatabaseLogSink | null = null;

/**
 * Enable or disable diagnostic logging for `firebase/database` client operations.
 * Accepts either a custom callback `(message: string) => void` or a boolean
 * toggle (`true` logs via `console.log`; `false` or `undefined` disables).
 * Passing `persistent = true` with a non-boolean custom logger throws synchronously.
 */
export function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  if (Boolean(persistent) && logger !== true && logger !== false) {
    throw new Error(PERSISTENT_CUSTOM_LOGGER_ERROR);
  }
  if (typeof logger === 'function') {
    activeLogSink = logger;
    return;
  }
  if (logger === true) {
    activeLogSink = (message: string) => {
      console.log(message);
    };
    return;
  }
  activeLogSink = null;
}

/** Internal hook invoked by client RTDB operations when logging is active. */
export function emitClientDatabaseLog(action: string, detail?: string): void {
  const sink = activeLogSink;
  if (sink === null) {
    return;
  }
  let formatted = `[pyric/database] ${action}`;
  if (detail !== undefined && detail.length > 0) {
    formatted = `${formatted} ${detail}`;
  }
  try {
    sink(formatted);
  } catch {
    // Isolate custom logger callback exceptions from database operations.
  }
}
