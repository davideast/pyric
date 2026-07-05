/**
 * `ConfirmHandler` interface + factory functions.
 *
 *   - `createInteractiveConfirmHandler` — production default for
 *     prod-mode bridges with a TTY. Wires `confirm-policy.ts` +
 *     `confirm-prompt.ts` + session state + timeout into one
 *     orchestrated dispatcher.
 *   - `createAutoApproveHandler` — auto-approves everything. For
 *     tests + `--non-interactive --i-mean-it` (loud warning at the
 *     CLI layer).
 *   - `createDenyAllHandler` — refuses everything. Fail-safe used
 *     when prod mode is configured without a TTY.
 *   - `createPolicyHandler` — CI-friendly. Uses an explicit
 *     allow-list / deny-list; anything not in either gets the
 *     configured default.
 *
 * Concurrent prompts queue inside `createInteractiveConfirmHandler`
 * — one prompt at a time. Session state ('a' → tool whitelist,
 * 'D' → session-wide deny) persists until the bridge restarts.
 */

import type { BridgeMode } from '../protocol.js';
import {
  type ConfirmPolicy,
  policyFor,
  FALLBACK_PROD_POLICY,
} from './confirm-policy.js';
import {
  type PromptIO,
  type PromptKey,
  hasInteractiveTTY,
  openTtyPromptIO,
  renderPrompt,
} from './confirm-prompt.js';
import type { BridgeLogger } from './logger.js';
import { createSilentLogger } from './logger.js';

export type { ConfirmPolicy } from './confirm-policy.js';

export interface ConfirmRequest {
  tool: string;
  args: Record<string, unknown>;
  mode: BridgeMode;
  project: string;
}

export interface ConfirmDecision {
  approved: boolean;
  reason:
    | 'policy-never'
    | 'policy-deny'
    | 'session-cached-approve'
    | 'session-cached-deny'
    | 'user-approved'
    | 'user-denied'
    | 'timeout'
    | 'no-tty';
  /** Wall-clock ms from `ask()` start to decision. */
  elapsedMs: number;
  /** When the prompt was actually shown (omitted for non-prompted paths). */
  promptShownAt?: Date;
}

export interface ConfirmHandler {
  /**
   * Get a decision for one tool call. Implementations MUST resolve
   * within `timeoutMs + small overhead` even if the user is idle.
   * Concurrent calls serialise (one prompt at a time).
   */
  ask(req: ConfirmRequest): Promise<ConfirmDecision>;
  /** Cleanup tty / file descriptors. Safe to call repeatedly. */
  close(): void;
}

export { hasInteractiveTTY };

// ── Factories ────────────────────────────────────────────────────────

export interface InteractiveOptions {
  /** Policy map; usually built via `buildPolicyMap(DEFAULT_PROD_POLICIES, overrides)`. */
  policies: ReadonlyMap<string, ConfirmPolicy>;
  /** Default policy for tools not in the map. */
  fallback?: ConfirmPolicy;
  /** Per-prompt timeout. Default 45_000 (45s). */
  timeoutMs?: number;
  /** Optional logger for lifecycle events (start/deny/approve). */
  logger?: BridgeLogger;
  /** Optional PromptIO override (tests inject a fake). Defaults to /dev/tty. */
  io?: PromptIO;
  /** Optional clock source for the prompt's timestamp. */
  now?: () => Date;
  /** Color output (default true if io supports it). */
  useColor?: boolean;
}

/**
 * Production-default handler. Reads from /dev/tty (or the supplied
 * `io`), enforces per-tool policies, queues concurrent prompts,
 * caches session-rule presses.
 */
export function createInteractiveConfirmHandler(
  opts: InteractiveOptions,
): ConfirmHandler {
  const policies = opts.policies;
  const fallback = opts.fallback ?? FALLBACK_PROD_POLICY;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const logger = opts.logger ?? createSilentLogger();
  const io = opts.io ?? openTtyPromptIO();
  const useColor = opts.useColor ?? true;
  const now = opts.now ?? (() => new Date());

  // Session state
  const approvedTools = new Set<string>();
  let sessionDenyAll = false;

  // One-prompt-at-a-time queue. Each ask() chains its prompt off
  // the previous promise so we never have two prompts rendered
  // simultaneously to the same tty.
  let queueTail: Promise<unknown> = Promise.resolve();

  async function ask(req: ConfirmRequest): Promise<ConfirmDecision> {
    const startedAtMs = Date.now();

    // ── Fast paths (no prompt) ────────────────────────────────────
    if (sessionDenyAll) {
      return {
        approved: false,
        reason: 'session-cached-deny',
        elapsedMs: Date.now() - startedAtMs,
      };
    }
    const policy = policyFor(policies, req.tool, fallback);
    if (policy === 'never') {
      return { approved: true, reason: 'policy-never', elapsedMs: Date.now() - startedAtMs };
    }
    if (policy === 'deny') {
      return { approved: false, reason: 'policy-deny', elapsedMs: Date.now() - startedAtMs };
    }
    if (approvedTools.has(req.tool)) {
      return {
        approved: true,
        reason: 'session-cached-approve',
        elapsedMs: Date.now() - startedAtMs,
      };
    }

    // ── Slow path (interactive prompt, serialised) ────────────────
    const myTurn = queueTail.then(async () => {
      // Re-check session state after waiting in the queue — earlier
      // prompts could have flipped `sessionDenyAll` or whitelisted
      // this tool.
      if (sessionDenyAll) {
        return {
          approved: false,
          reason: 'session-cached-deny' as const,
          elapsedMs: Date.now() - startedAtMs,
        };
      }
      if (approvedTools.has(req.tool)) {
        return {
          approved: true,
          reason: 'session-cached-approve' as const,
          elapsedMs: Date.now() - startedAtMs,
        };
      }

      const promptShownAt = now();
      const promptText = renderPrompt({
        tool: req.tool,
        args: req.args,
        project: req.project,
        policy: policy as 'always' | 'session',
        now,
        useColor,
        asUser: extractAsUser(req.args),
      });
      io.write(promptText);
      logger.info(`prompting: ${req.tool}`);

      const key = await io.readKey(timeoutMs);
      // Print a newline after the response key so subsequent output
      // appears on its own line.
      io.write('\n');
      return decideFromKey(key, req, approvedTools, () => {
        sessionDenyAll = true;
      }, startedAtMs, promptShownAt, logger);
    });
    // Tail tracks the OUTCOME so the next prompt only starts after
    // this one resolves (either via key or via timeout).
    queueTail = myTurn.catch(() => undefined);
    return myTurn;
  }

  function close() {
    try {
      io.close();
    } catch {
      // best-effort
    }
  }

  return { ask, close };
}

function decideFromKey(
  key: PromptKey,
  req: ConfirmRequest,
  approvedTools: Set<string>,
  setSessionDenyAll: () => void,
  startedAtMs: number,
  promptShownAt: Date,
  logger: BridgeLogger,
): ConfirmDecision {
  const base = {
    elapsedMs: Date.now() - startedAtMs,
    promptShownAt,
  };
  switch (key) {
    case 'approve':
      logger.info(`approved: ${req.tool}`);
      return { ...base, approved: true, reason: 'user-approved' };
    case 'deny':
      logger.info(`denied: ${req.tool}`);
      return { ...base, approved: false, reason: 'user-denied' };
    case 'approve-tool':
      approvedTools.add(req.tool);
      logger.info(`session-approved tool: ${req.tool}`);
      return { ...base, approved: true, reason: 'user-approved' };
    case 'deny-all':
      setSessionDenyAll();
      logger.info(`session-wide DENY engaged`);
      return { ...base, approved: false, reason: 'user-denied' };
    case 'timeout':
      logger.info(`prompt timed out: ${req.tool}`);
      return { ...base, approved: false, reason: 'timeout' };
    case 'unknown':
    default:
      // Treat unknown keys as deny — safer than re-prompting and
      // possibly hanging Claude Code past its tool timeout.
      logger.info(`prompt unknown-key (denied): ${req.tool}`);
      return { ...base, approved: false, reason: 'user-denied' };
  }
}

function extractAsUser(args: Record<string, unknown>): string | null {
  // Tools that run with rule evaluation usually pass an `auth: { uid }` arg.
  const auth = args.auth;
  if (auth && typeof auth === 'object') {
    const uid = (auth as { uid?: unknown }).uid;
    if (typeof uid === 'string' && uid.length > 0) return uid;
  }
  return null;
}

// ── Non-interactive factories ────────────────────────────────────────

/** Approve everything. Tests + `--non-interactive --i-mean-it`. */
export function createAutoApproveHandler(): ConfirmHandler {
  return {
    async ask(): Promise<ConfirmDecision> {
      return { approved: true, reason: 'policy-never', elapsedMs: 0 };
    },
    close() {},
  };
}

/** Deny everything. Fail-safe used when prod mode lacks a TTY. */
export function createDenyAllHandler(): ConfirmHandler {
  return {
    async ask(): Promise<ConfirmDecision> {
      return { approved: false, reason: 'no-tty', elapsedMs: 0 };
    },
    close() {},
  };
}

export interface PolicyHandlerOptions {
  /** Tools that auto-approve. */
  allow: ReadonlySet<string>;
  /** Tools that auto-deny. */
  deny?: ReadonlySet<string>;
  /** Behavior for tools in neither set. */
  default: 'approve' | 'deny';
}

/**
 * CI-friendly handler with explicit allow / deny lists. No TTY,
 * no session state. Anything not in either list gets `default`.
 *
 * Used by `--non-interactive --auto-approve <list>`.
 */
export function createPolicyHandler(opts: PolicyHandlerOptions): ConfirmHandler {
  const allow = opts.allow;
  const deny = opts.deny ?? new Set<string>();
  const fallback = opts.default;
  return {
    async ask(req): Promise<ConfirmDecision> {
      if (allow.has(req.tool)) {
        return { approved: true, reason: 'policy-never', elapsedMs: 0 };
      }
      if (deny.has(req.tool)) {
        return { approved: false, reason: 'policy-deny', elapsedMs: 0 };
      }
      return {
        approved: fallback === 'approve',
        reason: fallback === 'approve' ? 'policy-never' : 'policy-deny',
        elapsedMs: 0,
      };
    },
    close() {},
  };
}
