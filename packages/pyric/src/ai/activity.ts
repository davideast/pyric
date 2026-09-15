import { sdkActivity } from '../sandbox/internal/sdk-activity.js';
import { getAiEvidence, type AiEvidence } from '../sandbox/internal/ai-evidence.js';
import type { UsageEvidence } from '../sandbox/internal/usage-evidence.js';
import type { AITarget } from './types.js';

/** One SDK request, regardless of streamed chunk count or chat entry point. */
export function beginAiActivity(target: AITarget, model: string, method: string) {
  const start = performance.now();
  let detail: AiEvidence = target.kind === 'sandbox' ? target.broker.observationIdentity(model)
    : { requestedModel: model, engine: 'unknown', usageSource: 'unknown' };
  const activity = sdkActivity.begin({ app: target, kind: 'operation', method,
    source: { service: 'ai', target: model, key: model } });
  activity.ai(detail);
  const observe = (value: object) => {
    detail = { ...detail, ...getAiEvidence(value) };
    activity.ai(detail);
  };
  let ended = false;
  return {
    chunk(value: object) {
      observe(value);
      detail = { ...detail, firstChunkMs: detail.firstChunkMs ?? performance.now() - start };
    },
    progress: () => activity.progress(),
    finish(value: object) {
      if (ended) return;
      ended = true;
      observe(value);
      detail = { ...detail, durationMs: performance.now() - start };
      activity.ai(detail);
      const usage: UsageEvidence = method === 'countTokens' ? {} : {
        ...(detail.usageSource === 'backend' ? { aiInputTokens: detail.inputTokens, aiOutputTokens: detail.outputTokens } : {}),
        ...(detail.usageSource === 'estimated' || detail.usageSource === 'scripted' ? { aiEstimatedTokens: detail.totalTokens } : {}),
        aiUnknownUsage: detail.inputTokens === undefined || detail.outputTokens === undefined || detail.usageSource === 'unknown' ? 1 : 0,
      };
      activity.delivered(undefined, usage);
      activity.complete();
    },
    fail(error?: unknown) {
      if (ended) return;
      ended = true;
      if (error && typeof error === 'object') observe(error);
      activity.ai({ ...detail, durationMs: performance.now() - start });
      activity.fail({ aiFailures: 1, ...(method === 'countTokens' ? {} : { aiUnknownUsage: 1 }) });
    },
  };
}
