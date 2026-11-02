/**
 * The factory's agent interface. A factory session runs one agent CLI in
 * its own sandbox, with no credential, and sends its model requests through
 * the bridge to the upstream forwarder outside (`upstream-forwarder.ts`),
 * which alone holds the credential. Everything that differs from one agent
 * CLI to another is an `AgentAdapter`:
 *
 * - its install on the host, and what the sandbox binds read-only for it;
 * - the command, arguments and environment of a session, and the
 *   directories it keeps under the session's HOME;
 * - its credential on the host, read per request, and where that lives, so
 *   no bind can reach it;
 * - its upstream policy: the host, the request lines and headers that pass,
 *   the body check, and what a response says about the upstream rate limit;
 * - how its output says it hit that limit.
 *
 * The session runner, the supervisor, the forwarder and the role prompts
 * depend on this file alone. Adapters live in `agents/<name>/`, and
 * `agents/registry.ts` maps a name to one.
 */
import type { Upstream } from '../model-forwarder.ts';

/** Header names, lowercase, as Node gives them, with their values. */
export type Headers = Record<string, string | string[] | undefined>;

/** The credential the forwarder puts on each request it sends on. Nothing in a sandbox ever holds it. */
export interface Credential {
  /** Set on every request sent upstream, after the allowlisted ones, so nothing the sandbox sent replaces them. */
  headers: Readonly<Record<string, string>>;
  /** Every secret value the credential holds, for the token scan. */
  secrets: readonly string[];
  /** Why it can't be used at `now` (it is about to lapse), or undefined. Never holds a value. */
  problemAt(now: Date): string | undefined;
}

export type CredentialRead = { ok: true; credential: Credential } | { ok: false; problem: string };

/** What a response says about the upstream rate limit. */
export interface RateLimit {
  /** The response was a 429. */
  limitReached: boolean;
  /** When requests pass again, ISO; null when the response named no time. */
  resetAt: string | null;
  /** How full each rate-limit window the response named is, in percent. */
  usedPercent: Record<string, number>;
}

export type BodyCheck = { ok: true; model: string } | { ok: false; reason: string; names: string[] };

/** What the forwarder lets through to the agent's upstream, and how it reads the answers. */
export interface UpstreamPolicy {
  /** Where requests go. The forwarder sets `host` to this host and checks TLS against it. */
  upstream: Upstream;
  /** Why the request line is refused, or undefined when it may pass. */
  lineRefusal(method: string, target: string): string | undefined;
  /** Whether a request header, by its lowercase name, is sent on. */
  isForwardedHeader(name: string): boolean;
  /** Checks a whole request body. */
  checkBody(body: Buffer): BodyCheck;
  /** What a response says about the upstream rate limit. `body` is the start of an error response's body, empty otherwise. */
  rateLimitOf(status: number, headers: Headers, body: string, now: Date): RateLimit;
  /** How long one forwarded request may take, sending to the response's end. */
  timeoutMs: number;
}

/** One session, as the sandbox sees it. */
export interface AgentSession {
  /** The agent's executable. */
  command: string;
  /** The app directory, inside the run directory: the agent's workspace and `$APP_DIR`. */
  cwd: string;
  /** The run directory, writable: `$RUN_DIR`. */
  runDir: string;
  /** The brief, specs and design, read-only: `$BRIEF_DIR`. */
  briefDir: string;
  /** The session's HOME, inside the run directory. */
  home: string;
  /** What the session is asked to do. */
  prompt: string;
  /** The role's skill, the agent's standing instructions. */
  instructions: string;
}

export interface Invocation {
  command: string;
  args: string[];
  /** Holds no secret. */
  env: Record<string, string>;
}

/** The agent as installed on the host. */
export interface AgentInstall {
  /** The executable, as a real path. */
  command: string;
  /** What the sandbox binds read-only for it. */
  binds: string[];
}

export interface AgentAdapter {
  /** The name `--agent` takes. */
  name: string;
  /** Finds the agent on the host. Throws, saying what is missing, when it can't. */
  install(env: NodeJS.ProcessEnv): AgentInstall;
  /** The host directories that hold the agent's credential. No bind may contain one, equal one or sit inside one. */
  credentialDirs: readonly string[];
  /** Reads the credential, outside every sandbox. Called once per forwarded request. */
  readCredential(): CredentialRead;
  policy: UpstreamPolicy;
  /** The directories under the session's HOME the agent needs, made inside the sandbox before it starts. */
  homeDirs(home: string): string[];
  /**
   * The command a session runs inside the sandbox. `bridgeUrl` is the
   * bridge, in plain HTTP on the sandbox's loopback; `env` is the session's
   * environment (`sessionEnvironment`), which the adapter may add to.
   */
  invocation(session: AgentSession, bridgeUrl: string, env: Record<string, string>): Invocation;
  /** Whether the agent's output (its stdout) says it hit the upstream rate limit. */
  reportsRateLimit(output: string): boolean;
}

/**
 * A session's environment, from nothing but `base` (PATH, LANG, TMPDIR and
 * the recorder's variables): its HOME, and the directories the role skills
 * name, `$BRIEF_DIR`, `$RUN_DIR` and `$APP_DIR`. The agent's commands
 * inherit them.
 */
export function sessionEnvironment(session: AgentSession, base: Record<string, string>): Record<string, string> {
  return { ...base, HOME: session.home, BRIEF_DIR: session.briefDir, RUN_DIR: session.runDir, APP_DIR: session.cwd };
}
