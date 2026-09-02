/**
 * Blocked-response detection: the ONE definition of "this envelope carries
 * no usable content because a filter fired", shared by the two places that
 * need it:
 *
 *   - `response-helpers.ts`, which throws upstream's exact
 *     `Response error: Candidate was blocked due to <reason>` out of
 *     `text()` / `functionCalls()` / `inlineDataParts()` when the caller
 *     reaches for content that isn't there;
 *   - `broker/broker.ts`, which lands a `response_blocked` event on the
 *     sandbox's unified stream at RESPONSE time, so the block is visible
 *     even when nobody ever calls `text()` (an app that renders
 *     `response.text ?? ''` used to show an empty bubble and nothing else).
 *
 * A block is not a rejection: production answers HTTP 200 with an empty
 * candidate and the reason in `finishReason` (SAFETY, RECITATION,
 * BLOCKLIST, PROHIBITED_CONTENT, SPII, the IMAGE_* variants), or, when the
 * PROMPT itself was refused, with no candidates at all and a
 * `promptFeedback.blockReason`. Nothing throws on the wire path.
 *
 * Leaf module by construction: it imports only `./enums.js` (which imports
 * nothing) and a type. `broker/` must NOT reach into `response-helpers.ts`
 * for this: that file pulls `./errors.js`, which imports `./broker/index.js`
 * as a value, and the round trip would be a real runtime cycle.
 */

import type { WireResponse } from './broker/types.js';
import { FinishReason } from './enums.js';

/**
 * Finish reasons that mean "no usable content": the installed
 * `@firebase/ai@2.12.0` `badFinishReasons` set, verbatim and in upstream's
 * order. Every one of these makes the response helpers throw instead of
 * returning text, which is exactly the set worth announcing to a developer.
 */
const BLOCKING_FINISH_REASONS: readonly string[] = [
  FinishReason.RECITATION,
  FinishReason.SAFETY,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
  FinishReason.IMAGE_OTHER,
  FinishReason.NO_IMAGE,
  FinishReason.IMAGE_RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.UNEXPECTED_TOOL_CALL,
  FinishReason.TOO_MANY_TOOL_CALLS,
  FinishReason.MISSING_THOUGHT_SIGNATURE,
  FinishReason.MALFORMED_RESPONSE,
];

/** Does this candidate's finish reason mean the content was withheld? */
export function isBlockingFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  return BLOCKING_FINISH_REASONS.some((reason) => reason === finishReason);
}

/** What a block was, in the wire's own vocabulary. Exactly one of
 *  `finishReason` (a candidate was withheld) / `blockReason` (the prompt was
 *  refused) is normally set; both may be absent when production sent
 *  `promptFeedback` with no reason at all. */
export interface ResponseBlock {
  /** Candidate-level: the blocking `finishReason` off candidate 0. */
  finishReason?: string;
  /** Candidate-level: production's own explanatory `finishMessage`. */
  finishMessage?: string;
  /** Prompt-level: `promptFeedback.blockReason`. */
  blockReason?: string;
}

/**
 * Classify an envelope, mirroring `hasValidCandidates` in
 * `response-helpers.ts` EXACTLY so the event stream and the thrown error can
 * never disagree: candidate 0 with a blocking finish reason is a block; no
 * candidate 0 at all plus any `promptFeedback` is a block; everything else
 * (including a plain `STOP` or `MAX_TOKENS`) is not.
 *
 * Returns `null` when the response is fine, so a caller reads as
 * `const block = describeResponseBlock(res); if (block !== null) …`.
 */
export function describeResponseBlock(response: WireResponse): ResponseBlock | null {
  const firstCandidate = response.candidates?.[0];
  if (firstCandidate !== undefined) {
    if (!isBlockingFinishReason(firstCandidate.finishReason)) return null;
    const candidateBlock: ResponseBlock = {};
    candidateBlock.finishReason = firstCandidate.finishReason;
    candidateBlock.finishMessage = firstCandidate.finishMessage;
    return candidateBlock;
  }
  if (response.promptFeedback === undefined) return null;
  const promptBlock: ResponseBlock = {};
  promptBlock.blockReason = response.promptFeedback.blockReason;
  return promptBlock;
}
