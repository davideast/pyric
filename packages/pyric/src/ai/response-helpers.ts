/**
 * Response helpers for `pyric/ai` -- `EnhancedGenerateContentResponse`
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
import { isJsonErrorEnvelope } from './broker/upstream-stream-redaction.js';
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

function isPlainWireResponse(value: unknown): value is WireResponse {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasGenerateContentFields(response: WireResponse): boolean {
  return (
    Array.isArray(response.candidates) ||
    response.promptFeedback !== undefined ||
    response.usageMetadata !== undefined ||
    response.modelVersion !== undefined ||
    response.responseId !== undefined
  );
}

/**
 * Aggregate streamed chunk envelopes into one response: upstream 2.12.0's
 * candidate/part merge, plus the pinned final-chunk metadata carry.
 * Candidate-less mid-stream error frames (including transport-packed array
 * envelopes) never leak into the aggregate or erase `promptFeedback`,
 * `usageMetadata`, `modelVersion`, or `responseId` (#1753).
 */
export function aggregateResponses(responses: WireResponse[]): WireResponse {
  const aggregated: WireResponse = {};
  let lastPromptFeedback: WireResponse['promptFeedback'];
  let lastUsage: WireResponse['usageMetadata'];
  let lastModelVersion: string | undefined;
  let lastResponseId: string | undefined;
  for (const response of responses) {
    if (!isPlainWireResponse(response)) continue;
    const isErrorOnly = isJsonErrorEnvelope(response) && !Array.isArray(response.candidates);
    if (isErrorOnly || !hasGenerateContentFields(response)) continue;
    if (response.promptFeedback !== undefined) lastPromptFeedback = response.promptFeedback;
    if (response.usageMetadata !== undefined) lastUsage = response.usageMetadata;
    if (response.modelVersion !== undefined) lastModelVersion = response.modelVersion;
    if (response.responseId !== undefined) lastResponseId = response.responseId;
    if (!Array.isArray(response.candidates)) continue;
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
      const extended = candidate as WireCandidate & {
        citationMetadata?: unknown;
        groundingMetadata?: unknown;
        urlContextMetadata?: unknown;
      };
      const slotExtended = slot as WireCandidate & {
        citationMetadata?: unknown;
        groundingMetadata?: unknown;
        urlContextMetadata?: unknown;
      };
      if (extended.citationMetadata !== undefined) {
        slotExtended.citationMetadata = extended.citationMetadata;
      }
      if (extended.groundingMetadata !== undefined) {
        slotExtended.groundingMetadata = extended.groundingMetadata;
      }
      if (
        typeof extended.urlContextMetadata === 'object' &&
        extended.urlContextMetadata !== null &&
        Object.keys(extended.urlContextMetadata as Record<string, unknown>).length > 0
      ) {
        slotExtended.urlContextMetadata = extended.urlContextMetadata;
      }
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
  if (lastPromptFeedback !== undefined) {
    aggregated.promptFeedback = lastPromptFeedback;
  }
  // Pinned delta vs installed 2.12.0 (which drops usage on the aggregate):
  // the final chunk's usageMetadata / modelVersion / responseId ride along.
  if (lastUsage !== undefined) aggregated.usageMetadata = structuredClone(lastUsage);
  if (lastModelVersion !== undefined) aggregated.modelVersion = lastModelVersion;
  if (lastResponseId !== undefined) aggregated.responseId = lastResponseId;
  return aggregated;
}
