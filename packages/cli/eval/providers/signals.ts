/**
 * The shared shape for a CLI's infrastructure signals: the patterns that tell
 * a finished run apart from a task failure. Each provider owns its own record
 * under `<cli>-signals.ts`, because the phrases and JSON shapes a CLI prints
 * are that CLI's concern, not the classifier's.
 */

export interface CliSignals {
  /** Stdout or stderr text that means the account or upstream was refused for quota. */
  throttled: RegExp[];
  /** Stdout or stderr text that means the run's stream was cut off mid-flight. */
  interrupted: RegExp[];
  /** Stdout text that means a built-in tool touched the sandbox, not the surface under test. */
  builtinToolUse: RegExp[];
}
