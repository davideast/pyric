/**
 * Terminal blocks for the AI diagnostics relayed to `POST /__pyric/denials`.
 *
 * Three things ride that route besides a rules denial, and each gets one
 * record in {@link AI_TERMINAL_BLOCKS}: the loosely-typed wire payload, the
 * formatter that renders it, and the two strings the route's throttle keys it
 * by. Adding a fourth kind is one entry here plus its narrower in
 * `ai-diagnostics-relay.ts`; the route itself dispatches through the table and
 * never grows another branch.
 *
 * Every payload field is JSON from the served page, so nothing here trusts a
 * type: each field is re-checked, and every remote-authored string goes
 * through the URL redaction and terminal sanitizing in `ai-terminal-text.ts`.
 */
import type { AiDiagnosticKind } from './ai-diagnostics-relay.js';
import { redactUrl } from 'pyric/ai/internal';
import { sanitizeForTerminal } from './ai-terminal-text.js';

/** Loosely-typed mirror of the AI rejection payload POSTed by
 *  `ai-diagnostics-relay.ts` (the wire shape lives there). */
export interface AiRejectionPayload {
  /** `'ai-rejection'`: what tells the route the body is NOT a rules denial. */
  kind?: unknown;
  /** Model resource the rejected op targeted. */
  model?: unknown;
  /** Resolved broker engine (`scripted` | `openai` | `gemini` | `custom`). */
  engine?: unknown;
  /** Wire error status (e.g. `INVALID_ARGUMENT`) and HTTP-ish code. */
  status?: unknown;
  code?: unknown;
  /** The rejection reason: production's own message for shape errors. */
  message?: unknown;
}

/** Loosely-typed mirror of the AI blocked-response payload. Unlike a
 *  rejection this carries no `message`: a filter block has no error envelope
 *  at all (HTTP 200, empty candidate), only the wire's reason enums, so the
 *  phrasing is this file's job. */
export interface AiBlockedPayload {
  /** `'ai-blocked'`: what tells the route the body is a filter block. */
  kind?: unknown;
  /** Model resource the blocked op targeted. */
  model?: unknown;
  /** Resolved broker engine (`scripted` | `openai` | `gemini` | `custom`). */
  engine?: unknown;
  /** Candidate-level block: `SAFETY`, `RECITATION`, `BLOCKLIST`, and so on. */
  finishReason?: unknown;
  /** Production's own explanatory text for the block, when it sent one. */
  finishMessage?: unknown;
  /** Prompt-level block: `promptFeedback.blockReason`. */
  blockReason?: unknown;
}

/** Loosely-typed mirror of the AI model-substitution payload. Not a refusal:
 *  the request SUCCEEDED, answered by a model the developer never named,
 *  which is why nothing else in the stack reports it. */
export interface AiModelSubstitutionPayload {
  /** `'ai-model-substituted'`: what tells the route the body is a swap. */
  kind?: unknown;
  /** The model the request asked for. */
  requestedModel?: unknown;
  /** The model the engine actually calls. */
  effectiveModel?: unknown;
  /** Resolved broker engine (`openai` | `gemini` | ...). */
  engine?: unknown;
  /** Why it differs, e.g. `engine modelMap`, `experimental alias`. */
  reason?: unknown;
}

/** What the route reads off a body before it knows which kind it holds. */
export type AiDiagnosticPayload = AiRejectionPayload & AiBlockedPayload & AiModelSubstitutionPayload;

/** A non-empty string field, sanitized, or `null` when the wire omitted it. */
function readText(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return sanitizeForTerminal(redactUrl(value));
}

/** A raw (unsanitized) string field, for throttle keys that never print. */
function readRawText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback;
  return value;
}

/**
 * The `model: <id> (engine: <name>)` line shared by the rejection and block
 * formatters, which report the same fact in the same place. Degrades to an
 * engine-only line, and to nothing at all when the event carried neither.
 */
function formatModelLine(model: unknown, engine: unknown): string | null {
  const flatModel = readText(model);
  const flatEngine = readText(engine);
  if (flatModel === null && flatEngine === null) return null;
  if (flatModel === null) return `      engine: ${flatEngine}`;
  if (flatEngine === null) return `      model: ${flatModel}`;
  return `      model: ${flatModel} (engine: ${flatEngine})`;
}

/**
 * Format a relayed AI broker rejection into the compact terminal block, the
 * same `  [pyric] ...` idiom the denial relay and the ai-proxy warning print.
 * Three lines at most: the reason production itself gives, then the model
 * (with the resolved engine, since a rejection reads very differently for
 * `scripted` than for a real upstream), then the wire status. Exported for
 * unit tests.
 */
export function formatAiRejectionBlock(payload: AiRejectionPayload): string {
  const message = readText(payload.message) ?? 'request rejected';
  const lines = [`  ⚠ [pyric] ai request rejected: ${message}`];
  const modelLine = formatModelLine(payload.model, payload.engine);
  if (modelLine !== null) lines.push(modelLine);
  const status = readText(payload.status);
  const code = typeof payload.code === 'number' ? payload.code : null;
  if (status !== null || code !== null) {
    const label = status ?? 'ERROR';
    let suffix = '';
    if (code !== null) suffix = ` (${code})`;
    lines.push(`      ${label}${suffix}`);
  }
  return lines.join('\n');
}

/**
 * Format a relayed AI filter block, in the same three lines as
 * {@link formatAiRejectionBlock}: the wire's own reason, the model + resolved
 * engine, then WHY there is no content. That third line matters more here
 * than for a rejection: a block throws nothing, so the only symptom a
 * developer sees is an empty answer, and production's `finishMessage` (when
 * it sent one) is the whole explanation. Exported for unit tests.
 */
export function formatAiBlockedBlock(payload: AiBlockedPayload): string {
  const finishReason = readText(payload.finishReason);
  const blockReason = readText(payload.blockReason);
  const reason = finishReason ?? blockReason ?? 'unknown';
  const lines = [`  ⚠ [pyric] ai response blocked: ${reason}`];
  const modelLine = formatModelLine(payload.model, payload.engine);
  if (modelLine !== null) lines.push(modelLine);
  const finishMessage = readText(payload.finishMessage);
  if (finishMessage !== null) {
    lines.push(`      ${finishMessage}`);
  } else if (finishReason === null && blockReason !== null) {
    lines.push('      the prompt was blocked before generation; no candidates were returned');
  } else {
    lines.push('      no content was returned; text() and functionCalls() throw for this finish reason');
  }
  return lines.join('\n');
}

/**
 * Format a relayed AI model substitution into ONE terminal line, a single
 * line on purpose: there is no error, no status, and no missing content to
 * explain. The whole fact IS the arrow, and the parenthetical says which
 * engine did it and why (`engine modelMap`, `experimental alias`, ...).
 * Exported for unit tests.
 */
export function formatAiModelSubstitutionBlock(payload: AiModelSubstitutionPayload): string {
  const requested = readText(payload.requestedModel) ?? 'unknown';
  const effective = readText(payload.effectiveModel) ?? 'unknown';
  const engine = readText(payload.engine);
  const reason = readText(payload.reason);
  const attribution = [engine, reason].filter((part) => part !== null);
  let suffix = '';
  if (attribution.length > 0) suffix = ` (${attribution.join(', ')})`;
  return `  ⚠ [pyric] ai model substituted: ${requested} → ${effective}${suffix}`;
}

/**
 * One record per AI diagnostic kind: how it prints, and the (target, reason)
 * pair the denials route throttles it by.
 *
 * The prefixes on `throttleTarget` keep an AI key from colliding with a
 * rules-denial key built from a Firestore path, or with each other: a
 * rejection, a block, and a substitution on the same model are three
 * different problems. `throttleReason` is each kind's identity: a block has
 * no message of its own, so its reason enum is what collapses an agent's
 * retry loop into one line, and a substitution's identity is the model it
 * actually called, so a swap onto a DIFFERENT model still prints.
 */
export interface AiTerminalBlock {
  format(payload: AiDiagnosticPayload): string;
  throttleTarget(payload: AiDiagnosticPayload): string;
  throttleReason(payload: AiDiagnosticPayload): string;
}

const AI_TERMINAL_BLOCKS: { [K in AiDiagnosticKind]: AiTerminalBlock } = {
  'ai-rejection': {
    format: formatAiRejectionBlock,
    throttleTarget: (payload) => `ai-rejection ${readRawText(payload.model, '')}`,
    throttleReason: (payload) => readRawText(payload.message, 'request rejected'),
  },
  'ai-blocked': {
    format: formatAiBlockedBlock,
    throttleTarget: (payload) => `ai-blocked ${readRawText(payload.model, '')}`,
    throttleReason: (payload) =>
      readRawText(payload.finishReason, readRawText(payload.blockReason, 'unknown')),
  },
  'ai-model-substituted': {
    format: formatAiModelSubstitutionBlock,
    throttleTarget: (payload) => `ai-model ${readRawText(payload.requestedModel, '')}`,
    throttleReason: (payload) => readRawText(payload.effectiveModel, 'unknown'),
  },
};

/** The record for a relayed body's `kind`, or `null` when the body is a rules
 *  denial (or anything else this route does not recognize). */
export function aiTerminalBlockFor(kind: unknown): AiTerminalBlock | null {
  if (typeof kind !== 'string') return null;
  if (!Object.hasOwn(AI_TERMINAL_BLOCKS, kind)) return null;
  return AI_TERMINAL_BLOCKS[kind as AiDiagnosticKind];
}
