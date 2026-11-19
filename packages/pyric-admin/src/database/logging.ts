/**
 * Process-scoped RTDB SDK logger state mirroring `firebase-admin/database`'s
 * `enableLogging(logger?, persistent?)`.
 */

type AdminDatabaseLogSink = (message: string) => void;

let activeLogSink: AdminDatabaseLogSink | null = null;

/**
 * Enable or disable diagnostic logging for `pyric-admin/database` operations.
 * Accepts either a custom callback `(message: string) => void` or a boolean
 * toggle (`true` logs via `console.log`; `false` or `undefined` disables).
 */
export function enableLogging(
  logger?: boolean | ((message: string) => void),
  persistent?: boolean,
): void {
  void persistent;
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

/** Internal hook invoked by `pyric-admin/database` operations when logging is active. */
export function emitAdminDatabaseLog(action: string, detail?: string): void {
  const sink = activeLogSink;
  if (sink === null) {
    return;
  }
  let formatted = `[pyric-admin/database] ${action}`;
  if (detail !== undefined && detail.length > 0) {
    formatted = `${formatted} ${detail}`;
  }
  try {
    sink(formatted);
  } catch {
    // Isolate custom logger callback exceptions from database operations.
  }
}
