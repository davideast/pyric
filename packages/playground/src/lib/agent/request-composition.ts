import {
  collectRequestToolNames,
  estimateRequestInputComposition as estimateRequestInputCompositionBase,
  requestInputCompositionTotal,
  safeStringify,
  tokenEstimate as tokenEstimateBase,
  type RequestCompositionMessageLike,
  type RequestCompositionToolLike,
  type RequestCompositionTraceLike,
  type RequestInputComposition,
} from '@inbrowser/agent/usage';
import { estimateTokens } from '~/lib/tools/behavior';

export {
  collectRequestToolNames,
  requestInputCompositionTotal,
  safeStringify,
};
export type {
  RequestCompositionMessageLike,
  RequestCompositionToolLike,
  RequestCompositionTraceLike,
  RequestInputComposition,
};

export function estimateRequestInputComposition(
  request: RequestCompositionTraceLike,
): RequestInputComposition {
  return estimateRequestInputCompositionBase(request, { estimateTokens: tokenEstimate });
}

export function tokenEstimate(value: string | undefined | null): number {
  return tokenEstimateBase(value, (text) => estimateTokens(text) ?? 0);
}
