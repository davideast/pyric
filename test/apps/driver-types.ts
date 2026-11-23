/**
 * Public scenario contract types (`App`, `DevServer`, `Scenario`, `scenario`)
 * and nested-install wiring options for the app scenario driver.
 */
import type { BrowserContext, Page } from '@playwright/test';
import type { AppProcess } from './app-process.ts';
import type { ExpectedCrash } from './crash-watch.ts';
import type { DependencyStore } from './dependency-store.ts';
import type { Tarballs } from './install.ts';

export type { ExpectedCrash };

/**
 * How `installProject` installs a nested project: from the run's dependency
 * store, with the run's tarballs. Tests pass a store over a stand-in npm, a
 * short limit, and their own report.
 */
export interface NestedInstalls {
  tarballs: Tarballs;
  store: Pick<DependencyStore, 'provide'>;
  /** How long one warm of the project's store entry gets; NESTED_INSTALL_ATTEMPT_MS by default. */
  attemptMs?: number;
  /** Where the `[runner]` lines go; the run's output by default. */
  report?: (line: string) => void;
  /** How long `close()` waits for an in-flight `installProject` to finish before teardown; 30 s by default. */
  closeWaitMs?: number;
}

export interface DevServer {
  /** `http://127.0.0.1:<port>` (`https://` for an HTTPS server), no trailing slash. */
  url: string;
  port: number;
  process: AppProcess;
}

export interface DevServerOptions {
  env?: Record<string, string>;
  name?: string;
  port?: number;
  /** Relative to the app directory: runs the dev server of a project the scenario created there. */
  cwd?: string;
  /** The app's config serves HTTPS in this run, so the url and readiness probe use https. */
  https?: boolean;
}

export interface ScriptResult {
  code: number | null;
  output: string;
}

export interface App {
  readonly name: string;
  /** The installed project directory. */
  readonly dir: string;
  /** Runs one named step. A failure inside it is reported with this name. */
  step<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  /**
   * Starts the app's Vite dev server (`vite` from the app's node_modules) on a
   * free port, or on `port` when given, and waits until it serves the page and
   * `/__pyric/init.json`. The port is passed on the command line, which
   * overrides the config file. Passing the port of a server the scenario
   * stopped brings a host back on the URL its pages already use. `cwd`
   * (relative to the app directory) runs the dev server of a project the
   * scenario created there, such as one `create-pyric` scaffolded.
   */
  devServer(options?: DevServerOptions): Promise<DevServer>;
  /**
   * Starts the installed `pyric sandbox` (no Vite: the import-map plane) on a
   * free port, or on `port` when given, from the app directory, and waits
   * until it serves the page and `/__pyric/init.json`. It serves the
   * directory `firebase.json`'s `hosting.public` names and runs no command.
   */
  sandboxServer(options?: { env?: Record<string, string>; name?: string; port?: number }): Promise<DevServer>;
  /** Runs `node --import @pyric/cli/register <script> ...args` to exit. Throws on a non-zero exit. */
  serverScript(script: string, args?: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Starts `node --import @pyric/cli/register <script> ...args` and returns at
   * once, without waiting for it to exit. The process runs until the scenario
   * stops it or the run ends; the run's teardown resumes it if it is paused.
   */
  serverProcess(script: string, args?: string[], options?: { env?: Record<string, string> }): AppProcess;
  /**
   * Runs the installed `pyric` command (`@pyric/cli`'s bin, under node) with
   * `args` to exit, from the app directory. Unlike `serverScript`, a non-zero
   * exit is returned rather than thrown, so a scenario can assert a refusal.
   */
  pyric(args: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Starts the installed `pyric` command with `args` and returns at once, as
   * `serverProcess` does, for a command that runs until stopped, such as
   * `pyric sandbox -- next dev`.
   */
  pyricProcess(args: string[], options?: { env?: Record<string, string> }): AppProcess;
  /**
   * Runs `command` with `args` to exit from `cwd` (relative to the app
   * directory; the app directory when omitted), with the app's environment.
   * A non-zero exit is returned rather than thrown. For the commands a user
   * types, such as `node node_modules/create-pyric/dist/bin.js` or `npm run dev`.
   */
  command(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Starts `command` with `args` from `cwd` (relative to the app directory)
   * with the app's environment and returns at once, as `serverProcess` does,
   * for a command that runs until stopped, such as `node node_modules/.bin/pyric-live`.
   */
  commandProcess(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): AppProcess;
  /**
   * Installs a project the scenario created inside the app directory, such
   * as one `create-pyric` scaffolded: its Pyric dependencies point at the
   * packed tarballs, as the app's own do, and its tree comes from the
   * dependency store. `path` must be declared in test/apps/nested-projects.ts.
   * Throws on a failed install.
   */
  installProject(path: string): Promise<ScriptResult>;
  /**
   * The browser context for this app. Requests and page WebSockets to hosts
   * other than 127.0.0.1 and localhost are blocked and logged unless a route
   * (`route` or `routeWebSocket`) answers them.
   */
  browser(): Promise<BrowserContext>;
  /** Opens `url` in a new page of the app's browser context. */
  page(url: string): Promise<Page>;
  /**
   * Watches a browser context the scenario made itself, in a browser it
   * launched, for crashes, as `browser()` does for its own (crash-watch.ts).
   */
  watchCrashes(context: BrowserContext): Promise<void>;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** A free TCP port on 127.0.0.1. */
  freePort(): Promise<number>;
  /**
   * A port on 127.0.0.1 whose connects never complete and never refuse, as a
   * closed port behaves under WSL mirrored networking. Held until the run ends.
   */
  blackholedPort(): Promise<number>;
  /** Every page's console lines, page errors, error responses, and blocked external connections so far, in order. */
  readonly browserLog: readonly string[];
  /**
   * Declares that a page request to a `/__pyric/` route may answer with an
   * error status, such as a download URL with the wrong token. Any other error
   * a `/__pyric/` route answers to a page fails the app after its scenario,
   * and so does a pattern that matched no error, unless `mayNotHappen` says
   * why the error comes only in some runs, such as one a race decides. An
   * answer a `devServer()` or `sandboxServer()` host gives after the scenario
   * stopped it does not count (host-errors.ts).
   */
  expectHostError(pattern: RegExp, options?: { mayNotHappen?: string }): void;
  /**
   * Counts an error response to a page the scenario opened in a browser it
   * launched itself, as `page()` counts its own: one from a `/__pyric/`
   * route fails the app unless `expectHostError` allows it. `body`, when
   * given, is the response text; its first line goes in the failure.
   */
  noteErrorResponse(status: number, method: string, url: string, body?: string): void;
  /**
   * Declares that a process an app process starts may outlive it, holding its
   * output pipes, such as a daemon the scenario starts on purpose. `pattern`
   * matches the leftover's command name. Any other leftover fails the app
   * after its scenario (#1274), and so does a pattern that matched no leftover.
   */
  expectLeftoverProcess(pattern: RegExp): void;
}

export type Scenario = (app: App) => Promise<void>;

/** Declares an app's scenario. The default export of `scenario.ts`. */
export function scenario(run: Scenario): Scenario {
  return run;
}
