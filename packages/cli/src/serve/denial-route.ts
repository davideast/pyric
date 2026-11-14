import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose, collectBody, isBodyTooLarge } from '../bridge/server/peer.js';
import { aiTerminalBlockFor, type AiDiagnosticPayload } from './ai-terminal-blocks.js';
import { sanitizeForTerminal, stripTerminalControls } from './ai-terminal-text.js';
import type { ServeLogger } from './server.js';

const DENIAL_THROTTLE_MS = 5_000;

/** Largest relayed denial the route reads. A real one is a message, a path, a
 *  uid and a short owner stack, a few KiB at most; the index route's 64 KiB
 *  leaves room for a deep stack without letting a page grow the server. */
export const DENIAL_BODY_LIMIT_BYTES = 64 * 1024;

/** Loosely-typed mirror of the client's relay payload -- JSON from the served
 *  page, read defensively since nothing here enforces the wire shape. */
export interface DenialRelayPayload {
  kind?: unknown;
  code?: unknown;
  message?: unknown;
  /** Sibling of `denialContext` on the sandbox error -- query-proof denials
   *  attach the suggested `where()` fix there; the client forwards it. */
  remediation?: unknown;
  /** The named RTDB instance the denied request addressed, when it named one. */
  instance?: unknown;
  denialContext?: {
    engine?: string;
    auth?: { uid?: string } | null;
    request?: { method?: string; path?: string };
    /** RTDB only: the rules node and expression that decided. */
    matchedPath?: string;
    matchedRule?: string;
    /** Fallback position, in case a denial path nests it in the context. */
    remediation?: string;
  } | null;
  /** A denied listener's owners, as the page recorded them when it opened. */
  owners?: unknown;
}

/** Per-dev-server-instance throttle: at most one printed line per key within
 *  {@link DENIAL_THROTTLE_MS}. Exported for unit tests. */
export function createDenialThrottle(windowMs: number = DENIAL_THROTTLE_MS): {
  /** `window` overrides the throttle's window for this key; `Infinity` prints once. */
  shouldPrint(key: string, now: number, window?: number): boolean;
} {
  const lastPrinted = new Map<string, number>();
  return {
    shouldPrint(key, now, window = windowMs) {
      const last = lastPrinted.get(key);
      if (last !== undefined && now - last < window) return false;
      lastPrinted.set(key, now);
      return true;
    },
  };
}
export type DenialThrottle = ReturnType<typeof createDenialThrottle>;

/** A page-supplied string as one terminal-safe line. Every field of a relayed
 *  denial comes from the served page, which need not be the developer's own
 *  code, so none of it reaches the terminal with control characters intact. */
function pageText(value: string): string {
  return sanitizeForTerminal(value);
}

/** A multi-line page-supplied string (a query-proof remediation) as indented
 *  terminal lines. Each line keeps its spacing and its whole length, because a
 *  reader pastes the `pyric rules test` command and the `Fixture case:` JSON
 *  out of it; only control and bidi characters are replaced. The denial body
 *  limit bounds the total, so no line or line count is cut here. */
function pageLines(value: string): string[] {
  const lines = value.split(/\r?\n/).map((line) => stripTerminalControls(line).trimEnd());
  const first = lines.findIndex((line) => line.length > 0);
  if (first === -1) return [];
  let last = lines.length - 1;
  while (lines[last]!.length === 0) last -= 1;
  return lines.slice(first, last + 1).map((line) => {
    if (line.length > 0) return `      ${line}`;
    return '';
  });
}

interface RelayedFrame {
  file: string;
  line: number;
  function?: string;
}

function isRelayedFrame(value: unknown): value is RelayedFrame {
  const frame = value as Partial<RelayedFrame> | null;
  return (
    typeof frame === 'object' &&
    frame !== null &&
    typeof frame.file === 'string' &&
    typeof frame.line === 'number'
  );
}

/** A frame's file as a reader looks for it: a served URL loses its origin and query. */
function frameLocation(frame: RelayedFrame): string {
  const path = frame.file.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  return pageText(`${path}:${frame.line}`);
}

/**
 * The `owner:` and `stack:` lines for a denied listener: the frame its owner
 * shows (the first outside the project's `owners.skip` modules), then the
 * application frames around it, innermost first. Nothing when no frame owner
 * was relayed.
 */
function ownerLines(owners: unknown): string[] {
  if (!Array.isArray(owners)) return [];
  const frame = owners.find((owner) => (owner as { kind?: unknown })?.kind === 'frame');
  if (!isRelayedFrame(frame)) return [];
  let name = '';
  if (typeof frame.function === 'string' && frame.function.length > 0) {
    name = `${pageText(frame.function)} `;
  }
  const lines = [`      owner: ${name}${frameLocation(frame)}`];
  const stack = (frame as { stack?: unknown }).stack;
  let chain: RelayedFrame[] = [];
  if (Array.isArray(stack)) {
    chain = stack.filter(isRelayedFrame);
  }
  if (chain.length > 1) lines.push(`      stack: ${chain.map(frameLocation).join(' ← ')}`);
  return lines;
}

/** Format a relayed denial into the compact terminal block: the message,
 *  then (when present) the request method/path, the auth uid, and any
 *  remediation guidance. A few lines, never a JSON dump. */
export function formatDenialBlock(payload: DenialRelayPayload): string {
  let message = 'permission denied';
  if (typeof payload.message === 'string') {
    message = payload.message;
  }
  const lines = [`  ⚠ [pyric] denied: ${pageText(message)}`];
  const ctx = payload.denialContext;
  const request = ctx?.request;
  if (request?.method && request?.path) {
    let instance = '';
    if (typeof payload.instance === 'string') {
      instance = ` (${pageText(payload.instance)})`;
    }
    lines.push(`      ${pageText(String(request.method))} ${pageText(String(request.path))}${instance}`);
  }
  const uid = ctx?.auth?.uid;
  let formattedUid = 'anonymous';
  if (uid !== undefined && uid !== null) {
    formattedUid = pageText(String(uid));
  }
  lines.push(`      auth: ${formattedUid}`);
  // An RTDB message names no rule, so the block names the deciding one.
  if (ctx?.engine === 'rtdb' && typeof ctx.matchedRule === 'string') {
    let node = '';
    if (typeof ctx.matchedPath === 'string') {
      node = `${pageText(ctx.matchedPath)} `;
    }
    lines.push(`      rule: ${node}${pageText(ctx.matchedRule)}`);
  }
  let remediation: string | undefined;
  if (typeof payload.remediation === 'string') {
    remediation = payload.remediation;
  } else {
    remediation = ctx?.remediation;
  }
  if (remediation) lines.push(...pageLines(String(remediation)));
  lines.push(...ownerLines(payload.owners));
  return lines.join('\n');
}

/**
 * The throttle key separator: a NUL byte, written as an escape so the file
 * stays greppable. It cannot occur in a Firestore path, a model id, or a
 * rejection reason, so no (target, reason) pair can be spelled two ways.
 */
const THROTTLE_KEY_SEPARATOR = '\x00';

/**
 * Print one AI diagnostic (a broker rejection, blocked response, or model
 * substitution) under the shared throttle. The denials route calls it for a
 * relayed body; the hosted runtime calls it for its own broker's events,
 * since a Node-owned broker has no page to relay from. Returns nothing and
 * ignores a payload whose `kind` is not an AI diagnostic.
 */
export function noteAiDiagnostic(
  throttle: DenialThrottle,
  logger: ServeLogger | undefined,
  payload: AiDiagnosticPayload,
): void {
  const aiBlock = aiTerminalBlockFor(payload.kind);
  if (aiBlock === null || logger === undefined) return;
  const key = `${aiBlock.throttleTarget(payload)}${THROTTLE_KEY_SEPARATOR}${aiBlock.throttleReason(payload)}`;
  const window = aiBlock.printsOnce ? Number.POSITIVE_INFINITY : undefined;
  if (throttle.shouldPrint(key, Date.now(), window)) logger.note(aiBlock.format(payload));
}

/** Handle `POST /__pyric/denials`: a rules denial, or (discriminated by
 *  `kind`) an AI broker rejection, blocked response, or model substitution
 *  relayed off the sandbox event stream. */
export async function handleDenials(
  throttle: DenialThrottle,
  logger: ServeLogger | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end('method not allowed');
    return;
  }
  try {
    const payload = (await collectBody(req, DENIAL_BODY_LIMIT_BYTES)) as DenialRelayPayload & AiDiagnosticPayload;
    const isAiDiagnostic = aiTerminalBlockFor(payload.kind) !== null;
    if (isAiDiagnostic) {
      noteAiDiagnostic(throttle, logger, payload);
    } else {
      const target = payload.denialContext?.request?.path ?? '';
      let reason = 'permission denied';
      if (typeof payload.message === 'string') {
        reason = payload.message;
      }
      let instance = '';
      if (typeof payload.instance === 'string') {
        instance = payload.instance;
      }
      const key = `${instance}${THROTTLE_KEY_SEPARATOR}${target}${THROTTLE_KEY_SEPARATOR}${reason}`;
      if (logger && throttle.shouldPrint(key, Date.now())) {
        logger.note(formatDenialBlock(payload));
      }
    }
  } catch (error) {
    const tooLarge = isBodyTooLarge(error);
    if (tooLarge) {
      answerAndClose(req, res, 413, { 'content-type': 'text/plain' }, 'Payload Too Large');
      return;
    }
    /* malformed body: drop it; this is a diagnostics side channel */
  }
  res.writeHead(204).end();
}
