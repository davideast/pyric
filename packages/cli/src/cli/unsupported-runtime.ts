/**
 * Child runtimes that cannot evaluate Node loader hooks, and the one warning
 * that says what is lost when a command starts one.
 */

/** Tokens that end one command and begin the next inside a shell string. */
export const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '&']);

/** Command basenames that cannot evaluate Node loader hooks, to the runtime. */
const UNSUPPORTED_RUNTIME_BINARIES = new Map<string, string>([
  ['bun', 'bun'],
  ['bunx', 'bun'],
  ['deno', 'deno'],
]);

/** Leading `KEY=VAL` environment assignments in a shell command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Strip directory and a Windows `.exe` suffix from a command token. */
function commandBasename(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * Decide whether the child command starts a runtime that cannot intercept.
 *
 * Detection is by command name: argv[0], and any token that begins a new
 * command after a shell operator, with leading `KEY=VAL` assignments skipped
 * and the path and `.exe` decoration stripped. That is the honest 90%.
 * `npm run dev` whose package script shells out to bun is undetectable from
 * here, and guessing would cost false positives on names that merely start
 * with the same letters (`bundle exec`).
 *
 * Returns the canonical runtime name (`bun` for `bunx` too) or null.
 */
export function detectUnsupportedRuntime(argv: readonly string[]): string | null {
  let atCommandStart = true;
  for (const token of argv) {
    if (atCommandStart && ENV_ASSIGNMENT.test(token)) continue;
    if (SHELL_OPERATORS.has(token)) {
      atCommandStart = true;
      continue;
    }
    if (atCommandStart) {
      const runtime = UNSUPPORTED_RUNTIME_BINARIES.get(commandBasename(token));
      if (runtime !== undefined) return runtime;
      atCommandStart = false;
    }
  }
  return null;
}

/**
 * The one warning. It has to say both halves of what is lost: the loader swap
 * (interception itself) and the net guard (the socket backstop that would
 * otherwise catch the egress), because the guard is installed by the same
 * `--import`ed register module and is therefore just as absent.
 */
export function formatUnsupportedRuntimeWarning(runtime: string): string {
  return (
    `  ⚠ runtime: pyric interception is not supported under \`${runtime}\`. It does not evaluate ` +
    `Node loader hooks, so the child's firebase/firebase-admin imports will NOT be rewritten and ` +
    `may reach LIVE Firebase. The net-guard socket backstop also only applies under Node, so it ` +
    `will not catch that egress either. Run the command under \`node\` (or \`npx tsx\`) for the ` +
    `sandbox swap. Warning only: nothing was blocked.\n`
  );
}
