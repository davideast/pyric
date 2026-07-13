/**
 * `pyric/ai/scripting` — the sandbox-only authoring surface for the
 * scripted answer engine (cdd-deltas #97).
 *
 *   - {@link script} wires an ordered entry queue into a sandbox AI
 *     handle's scripted engine: raw Gemini envelopes (captures paste in),
 *     shorthands (`text` / `json` / `functionCall` / `chunks` / `error`),
 *     and matchers (substring / regex / predicate). The wire-error entry
 *     form `{ error: { httpStatus, body } }` — an HTTP capture pasted
 *     whole — normalizes into the broker's envelope shorthand here.
 *   - {@link encodeSse} frames envelopes exactly as production's SSE wire
 *     does (`ai-generate-stream-framing`): `data: `-prefixed complete JSON
 *     events separated by CRLF CRLF.
 *
 * Everything else (expansion, synthesis, framing semantics) is the broker's
 * — this module only adapts authoring shapes; it never duplicates envelope
 * synthesis.
 */

import {
  ScriptedEngine,
  type ScriptEntry,
  type ScriptMatcher,
  type ScriptRespond,
  type WireResponse,
} from './broker/index.js';
import { AIError, AIErrorCode } from './errors.js';
import { targetOf, type AI } from './target.js';

export type { ScriptEntry, ScriptMatcher, ScriptRespond } from './broker/index.js';

/** An HTTP error capture pasted whole: status + the wire error body. */
export interface HttpErrorRespond {
  error: {
    httpStatus: number;
    body: {
      error: {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<Record<string, unknown>>;
      };
    };
  };
}

/** A script entry as authored: broker entries plus the HTTP-capture error form. */
export interface ScriptingEntry {
  match?: ScriptMatcher;
  respond: ScriptRespond | HttpErrorRespond;
}

function isHttpErrorRespond(respond: ScriptingEntry['respond']): respond is HttpErrorRespond {
  if (respond === null || typeof respond !== 'object' || !('error' in respond)) return false;
  const error = (respond as HttpErrorRespond).error;
  return (
    error !== null &&
    typeof error === 'object' &&
    'httpStatus' in error &&
    typeof error.httpStatus === 'number'
  );
}

function normalizeEntry(entry: ScriptingEntry): ScriptEntry {
  if (!isHttpErrorRespond(entry.respond)) {
    return entry as ScriptEntry;
  }
  const { httpStatus, body } = entry.respond.error;
  const wire = body?.error ?? {};
  return {
    ...(entry.match !== undefined ? { match: entry.match } : {}),
    respond: {
      error: {
        code: wire.code ?? httpStatus,
        message: wire.message ?? '',
        status: wire.status ?? 'INVALID_ARGUMENT',
        ...(wire.details !== undefined ? { details: wire.details } : {}),
      },
    },
  };
}

/**
 * Append entries to the scripted engine behind a sandbox AI handle. Entries
 * are consumed at most once, first unconsumed match wins, matcher-less
 * entries are unconditional FIFO (broker semantics).
 */
export function script(ai: AI, entries: ScriptingEntry[]): void {
  const target = targetOf(ai);
  const engine = target.broker.engine;
  if (!(engine instanceof ScriptedEngine)) {
    throw new AIError(
      AIErrorCode.UNSUPPORTED,
      "script(ai, entries) requires the scripted engine (the getAI(sandbox) default, or engine: { kind: 'scripted' }).",
    );
  }
  engine.push(...entries.map(normalizeEntry));
}

/**
 * Encode complete response envelopes as the captured SSE framing bytes:
 * every event is `data: <complete JSON>`, events separated by CRLF CRLF
 * (`ai-generate-stream-framing`: allEventsDataPrefixed, separatorIsCrlfCrlf).
 */
export function encodeSse(envelopes: WireResponse[]): string {
  return envelopes.map((envelope) => `data: ${JSON.stringify(envelope)}\r\n\r\n`).join('');
}
