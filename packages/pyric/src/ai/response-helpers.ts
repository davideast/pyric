/**
 * Response helpers for `pyric/ai` — `EnhancedGenerateContentResponse`
 * decoration ported from the installed `@firebase/ai@2.12.0`
 * response-helpers (dist/index.node.mjs):
 *
 *   - `text()` / `thoughtSummary()` / `inlineDataParts()` / `functionCalls()`
 *     helpers attached to the plain envelope; data keys stay exactly the
 *     wire's (`dataKeys` fact of `ai-generate-minimal-envelope`).
 *   - `badFinishReasons` throw semantics with upstream's EXACT messages:
 *     "Response error: <blockErrorMessage>. Response body stored in
 *     error.response" and "Text not available. <blockErrorMessage>".
 *   - The denied hybrid `inferenceSource` property is NEVER added (surface
 *     inventory: client-side SDK addition, absent from the mirrored plane).
 *
 * Aggregation of streamed chunks follows the installed `aggregateResponses`
 * candidate/part merge (empty text parts skipped, latest metadata wins),
 * with the registry-pinned delta that the FINAL chunk's `usageMetadata`,
 * `modelVersion`, and `responseId` ride the aggregate (rows
 * ai#stream-aggregate-final-meta / ai#chat-sendmessagestream).
 */

import type { WireCandidate, WirePart, WireResponse } from './broker/index.js';
import { AIError, AIErrorCode } from './errors.js';
import { isBlockingFinishReason } from './blocked.js';

/** The wire envelope plus the SDK's helper methods. */
export interface EnhancedResponse extends WireResponse {
  text(): string;
  thoughtSummary(): string | undefined;
  inlineDataParts(): WirePart[] | undefined;
  functionCalls(): Array<NonNullable<WirePart['functionCall']>> | undefined;
}

// Upstream's `badFinishReasons` set lives in `blocked.ts`: the broker
// announces the SAME set on the event stream (`response_blocked`), and the
// two must never drift apart.

export function formatBlockErrorMessage(response: WireResponse): string {
  let message = '';
  if ((!response.candidates || response.candidates.length === 0) && response.promptFeedback) {
    message += 'Response was blocked';
    if (response.promptFeedback?.blockReason) {
      message += ` due to ${response.promptFeedback.blockReason}`;
    }
  } else if (response.candidates?.[0]) {
    const firstCandidate = response.candidates[0];
    if (isBlockingFinishReason(firstCandidate.finishReason)) {
      message += `Candidate was blocked due to ${firstCandidate.finishReason}`;
      if (firstCandidate.finishMessage) {
        message += `: ${firstCandidate.finishMessage}`;
      }
    }
  }
  return message;
}

/** At least one candidate exists and the first has no bad finish reason. */
function hasValidCandidates(response: WireResponse): boolean {
  if (response.candidates && response.candidates.length > 0) {
    if (isBlockingFinishReason(response.candidates[0]!.finishReason)) {
      throw new AIError(
        AIErrorCode.RESPONSE_ERROR,
        `Response error: ${formatBlockErrorMessage(response)}. Response body stored in error.response`,
        { response },
      );
    }
    return true;
  }
  return false;
}

function getText(response: WireResponse, partFilter: (part: WirePart) => boolean): string {
  const textStrings: string[] = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.text && partFilter(part)) {
      textStrings.push(part.text);
    }
  }
  return textStrings.length > 0 ? textStrings.join('') : '';
}

function getFunctionCalls(
  response: WireResponse,
): Array<NonNullable<WirePart['functionCall']>> | undefined {
  const functionCalls: Array<NonNullable<WirePart['functionCall']>> = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall) {
      functionCalls.push(part.functionCall);
    }
  }
  return functionCalls.length > 0 ? functionCalls : undefined;
}

function getInlineDataParts(response: WireResponse): WirePart[] | undefined {
  const data: WirePart[] = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      data.push(part);
    }
  }
  return data.length > 0 ? data : undefined;
}

/**
 * Attach the helper methods to a (mutable, broker-owned) envelope. Mirrors
 * upstream `createEnhancedContentResponse`/`addHelpers` minus the denied
 * `inferenceSource` stamp.
 */
export function createEnhancedContentResponse(response: WireResponse): EnhancedResponse {
  if (response.candidates && response.candidates.length > 0 && response.candidates[0]!.index === undefined) {
    response.candidates[0]!.index = 0;
  }
  const enhanced = response as EnhancedResponse;
  enhanced.text = () => {
    if (hasValidCandidates(enhanced)) {
      return getText(enhanced, (part) => !part.thought);
    } else if (enhanced.promptFeedback) {
      throw new AIError(
        AIErrorCode.RESPONSE_ERROR,
        `Text not available. ${formatBlockErrorMessage(enhanced)}`,
        { response: enhanced },
      );
    }
    return '';
  };
  enhanced.thoughtSummary = () => {
    if (hasValidCandidates(enhanced)) {
      const result = getText(enhanced, (part) => !!part.thought);
      return result === '' ? undefined : result;
    } else if (enhanced.promptFeedback) {
      throw new AIError(
        AIErrorCode.RESPONSE_ERROR,
        `Thought summary not available. ${formatBlockErrorMessage(enhanced)}`,
        { response: enhanced },
      );
    }
    return undefined;
  };
  enhanced.inlineDataParts = () => {
    if (hasValidCandidates(enhanced)) {
      return getInlineDataParts(enhanced);
    } else if (enhanced.promptFeedback) {
      throw new AIError(
        AIErrorCode.RESPONSE_ERROR,
        `Data not available. ${formatBlockErrorMessage(enhanced)}`,
        { response: enhanced },
      );
    }
    return undefined;
  };
  enhanced.functionCalls = () => {
    if (hasValidCandidates(enhanced)) {
      return getFunctionCalls(enhanced);
    } else if (enhanced.promptFeedback) {
      throw new AIError(
        AIErrorCode.RESPONSE_ERROR,
        `Function call not available. ${formatBlockErrorMessage(enhanced)}`,
        { response: enhanced },
      );
    }
    return undefined;
  };
  return enhanced;
}

/**
 * Aggregate streamed chunk envelopes into one response: upstream 2.12.0's
 * candidate/part merge, plus the pinned final-chunk metadata carry.
 */
export function aggregateResponses(responses: WireResponse[]): WireResponse {
  const lastResponse = responses[responses.length - 1];
  const aggregated: WireResponse = {};
  if (lastResponse?.promptFeedback) {
    aggregated.promptFeedback = lastResponse.promptFeedback;
  }
  for (const response of responses) {
    if (!response.candidates) continue;
    for (const candidate of response.candidates) {
      const i = candidate.index || 0;
      aggregated.candidates ??= [];
      let slot = aggregated.candidates[i];
      if (!slot) {
        slot = { index: candidate.index ?? i } as WireCandidate;
        aggregated.candidates[i] = slot;
      }
      if (candidate.finishReason !== undefined) slot.finishReason = candidate.finishReason;
      if (candidate.finishMessage !== undefined) slot.finishMessage = candidate.finishMessage;
      if (candidate.safetyRatings !== undefined) slot.safetyRatings = candidate.safetyRatings;
      if (candidate.content) {
        if (!candidate.content.parts) continue;
        if (!slot.content) {
          slot.content = { role: candidate.content.role || 'model', parts: [] };
        }
        for (const part of candidate.content.parts) {
          const newPart = { ...part };
          // The backend can send empty text parts; replaying them errors.
          if (part.text === '') continue;
          if (Object.keys(newPart).length > 0) {
            slot.content.parts.push(newPart);
          }
        }
      }
    }
  }
  // Pinned delta vs installed 2.12.0 (which drops usage on the aggregate):
  // the final chunk's usageMetadata / modelVersion / responseId ride along.
  if (lastResponse?.usageMetadata) aggregated.usageMetadata = structuredClone(lastResponse.usageMetadata);
  if (lastResponse?.modelVersion !== undefined) aggregated.modelVersion = lastResponse.modelVersion;
  if (lastResponse?.responseId !== undefined) aggregated.responseId = lastResponse.responseId;
  return aggregated;
}
