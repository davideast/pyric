/**
 * Tiny logger for bridge lifecycle events. The bridge core stays
 * silent; consumers (standalone CLI, Vite plugin) wire a logger
 * here when they want visibility.
 *
 * Premortem #U1 + #I7 + #U2 + #U3 all stemmed from "we never
 * print what's happening." This module is the single observability
 * surface so adding a log line at the bridge happens once, here.
 *
 * Levels: `info` for lifecycle (start, peer connect/disconnect),
 * `verbose` for per-call (only emitted when verbose=true).
 */

export interface BridgeLogger {
  info(line: string): void;
  verbose(line: string): void;
  error(line: string): void;
}

/**
 * Default logger that writes to stderr with a `[pyric]` prefix.
 * Verbose lines are gated behind `PYRIC_VERBOSE=1` env var unless
 * the option overrides it.
 */
export function createConsoleLogger(options: { verbose?: boolean } = {}): BridgeLogger {
  const verboseEnabled =
    options.verbose ?? Boolean(process.env.PYRIC_VERBOSE);
  return {
    info(line) {
      process.stderr.write(`[pyric] ${line}\n`);
    },
    verbose(line) {
      if (verboseEnabled) {
        process.stderr.write(`[pyric] ${line}\n`);
      }
    },
    error(line) {
      process.stderr.write(`[pyric] error: ${line}\n`);
    },
  };
}

/** Silent logger — useful in tests. */
export function createSilentLogger(): BridgeLogger {
  return {
    info() {},
    verbose() {},
    error() {},
  };
}
