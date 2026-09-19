import type { SandboxOperationEvent } from 'pyric/sandbox';
import { observationText, resolveOperationContext, emitSandboxEvent, makeSandboxOperationEvent } from 'pyric/sandbox/internal';
import { getAiEvidence, type AiEvidence } from 'pyric/ai/internal';
import { portSession } from './host-auth.js';
import { randomUuid } from './host/connection.js';
import { opProvenance } from './host/core.js';
import { activityJourneyId, type HostCtx, type PortLike } from './host-context.js';
import { serializeError, type InboundMessage } from './protocol.js';

/** Observe execution where all worker clients meet; never retain prompts or credentials. */
export function observeAiRequest(ctx: HostCtx, port: PortLike, message: InboundMessage, method: string, model: string) {
  const startedAt = Date.now();
  const started = performance.now();
  const id = randomUuid();
  const session = portSession(ctx, port);
  const auth = session ? { uid: session.user.uid } : null;
  const issued = resolveOperationContext(opProvenance(message, activityJourneyId(ctx, port)), undefined);
  const lens = issued.authLens;
  const authLens = lens.mode === 'as' ? { mode: 'as' as const, uid: lens.uid, tenant: lens.tenant } : lens;
  const context = { ...issued, authLens };
  let ai: AiEvidence = { requestedModel: model, engine: 'unknown', usageSource: 'unknown' };
  let text = '';
  let truncated = false;
  let finished = false;
  let firstChunkMs: number | undefined;
  let lastProgressAt = -Infinity;
  const publish = (status: NonNullable<SandboxOperationEvent['observation']>['status'], code?: string) => {
    const pending = status === 'pending';
    const at = Date.now();
    const durationMs = pending ? undefined : performance.now() - started;
    const event = makeSandboxOperationEvent({
      at, service: 'ai', method, path: model, auth,
      result: status === 'failed' ? 'error' : 'not-applicable', origin: 'user',
      rulesDisposition: { kind: 'not-evaluated', reason: 'not-a-rules-operation' },
      durationMs,
      observation: { id, startedAt, status,
        endedAt: pending ? undefined : at,
        ai: { ...ai, firstChunkMs, durationMs },
        response: text ? { text: observationText(text), truncated } : undefined,
        error: code ? { code } : undefined },
    });
    emitSandboxEvent(ctx.sandbox, { ...event, operationContext: context });
  };
  publish('pending');
  return {
    identity(value?: AiEvidence) { if (value) ai = { ...value }; publish('pending'); },
    response(value: Record<string, unknown>, streaming = false) {
      ai = { ...ai, ...getAiEvidence(value) };
      if (streaming) firstChunkMs ??= performance.now() - started;
      // Only text parts from the model are eligible; no headers, tools, or auth envelopes.
      const candidates = value.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
      for (const part of candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text !== 'string') continue;
        const remaining = Math.max(0, 16384 - text.length);
        truncated ||= part.text.length > remaining;
        text += part.text.slice(0, remaining);
      }
      const shouldPublish = streaming && !finished && performance.now() - lastProgressAt >= 200;
      if (shouldPublish) {
        lastProgressAt = performance.now();
        publish('pending');
      }
    },
    finish(status: 'completed' | 'failed' | 'cancelled', error?: unknown) {
      if (finished) return;
      finished = true;
      const code = status === 'failed' ? serializeError(error).code : undefined;
      const safeCode = code && /^[a-z0-9_/-]{1,100}$/i.test(code) ? code : undefined;
      publish(status, safeCode);
    },
  };
}
