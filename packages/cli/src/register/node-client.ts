/**
 * How a live Node process's connection to the live host ends, and the label
 * it names itself by.
 *
 * The host retains a closed connection's session for a while, so a process
 * that exits without a word keeps its reported listeners active until the
 * retention ends. A restart under `node --watch` or nodemon inside that window
 * attaches them again, and the host would read one listener three times.
 * So the observed-call sender ends its connection as the process exits
 * (`endWithProcess`), and names its project root and entry script with each
 * observed call (`nodeClientLabel`), which lets the host detach the listeners
 * of an earlier run of the same script that closed without ending, such as a
 * killed one. Each frame also names the entry script itself, relative to the
 * process's working directory (`nodeClientScript`), so the host can tell two
 * processes apart by the script they run.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** The process events the sender ends its connection on. */
type ExitSignal = 'SIGTERM' | 'SIGINT';
type ExitEvent = 'beforeExit' | ExitSignal;

/** The part of `process` this module uses, so a test can stand one in. */
export interface ExitingProcess {
  readonly pid: number;
  on(event: ExitEvent, listener: () => void): unknown;
  once(event: ExitEvent, listener: () => void): unknown;
  listenerCount(event: ExitEvent): number;
  kill(pid: number, signal: ExitSignal): unknown;
}

const EXIT_SIGNALS: readonly ExitSignal[] = ['SIGTERM', 'SIGINT'];

/**
 * Run `end` when the process is about to exit, without changing how it
 * exits. On `beforeExit` it only ends the connection. A listener on SIGTERM
 * or SIGINT stops Node's default exit, so once `end` settles, a process
 * whose app has no listener of its own for that signal sends it to itself
 * again and exits by it, as it would have; an app that handles the signal
 * keeps its own exit. Call it once per process.
 */
export function endWithProcess(end: () => Promise<void>, proc: ExitingProcess = process): void {
  proc.on('beforeExit', () => {
    void end().catch(() => undefined);
  });
  for (const signal of EXIT_SIGNALS) {
    proc.once(signal, () => {
      const exitAsBefore = (): void => {
        const appHandlesSignal = proc.listenerCount(signal) > 0;
        if (!appHandlesSignal) proc.kill(proc.pid, signal);
      };
      void end().catch(() => undefined).then(exitAsBefore);
    });
  }
}

/** Where a live Node process runs from. */
export interface NodeClientPlace {
  /** The project root the register found (`liveProjectRoot`). */
  readonly projectRoot: string;
  readonly cwd: string;
  /** `process.argv[1]`. */
  readonly entry: string | undefined;
  readonly execArgv: readonly string[];
}

/** The flags that run code from the command line, so `argv[1]` is not an entry script. */
function runsEval(execArgv: readonly string[]): boolean {
  return execArgv.some((flag) => ['-e', '--eval', '-p', '--print'].includes(flag) || flag.startsWith('--eval=') || flag.startsWith('--print='));
}

/**
 * The label a live Node process names itself by: a hash of its project root
 * and its entry script's path, so each run of one script shares it and the
 * label carries no path. A process that runs code with `-e` has no entry
 * script and names only its project root.
 */
export function nodeClientLabel(place: NodeClientPlace): string {
  const entry = runsEval(place.execArgv) ? '' : place.entry ?? '';
  const entryPath = entry === '' ? '' : resolve(place.cwd, entry);
  return createHash('sha256').update(`${place.projectRoot}\0${entryPath}`).digest('hex').slice(0, 32);
}

/** The longest script path a process names; the host keeps no longer one. */
const MAX_SCRIPT_LENGTH = 256;

/**
 * The entry script a live Node process names itself by on the host: its path
 * relative to the working directory, with `/` separators, such as
 * `server.mjs` or `jobs/nightly.ts`. Never an absolute path, so it carries
 * no home directory. Undefined for a process with no entry script (`-e`, a
 * REPL), one the working directory cannot reach by a relative path, or a
 * path too long to keep. A label, never an authority.
 */
export function nodeClientScript(place: Pick<NodeClientPlace, 'cwd' | 'entry' | 'execArgv'>): string | undefined {
  const entry = runsEval(place.execArgv) ? '' : place.entry ?? '';
  if (entry === '') return undefined;
  const fromCwd = relative(place.cwd, resolve(place.cwd, entry));
  const isUsable = fromCwd !== '' && !isAbsolute(fromCwd) && fromCwd.length <= MAX_SCRIPT_LENGTH;
  return isUsable ? fromCwd.split(sep).join('/') : undefined;
}
