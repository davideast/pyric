/**
 * Register one scripted response on the local scripted answer engine.
 *
 * `match` narrows the call this entry answers by prompt substring, by the
 * model the call names, by both, or by neither, which answers the next
 * unmatched call. A model comparison strips a leading `models/`, so
 * `gemini-2.0-flash` and `models/gemini-2.0-flash` name the same match.
 * `response.payload` must agree with `response.type`: a string for `text`,
 * a plain object for `json`, `{ code, message }` for `error`; a call whose
 * two disagree is refused naming the accepted form.
 *
 * This reaches only the scripted engine. When the project's AI Logic engine
 * is configured for production pass-through (gemini) or a local loopback
 * (openai), this call is refused; `ai_logic`'s `status` method names which
 * engine is actually resolved.
 */
import { z } from 'zod';
import { AIError, AIErrorCode } from 'pyric/ai';
import { script as scriptEngine } from 'pyric/ai/scripting';
import { scriptMatchArgument, scriptResponseArgument } from '../../arguments/ai_logic.js';
import { operationFailure } from '../../context.js';
import { aiFor } from '../../service-handles.js';
import { matcherFor, respondFor, type ScriptMatch, type ScriptResponse } from '../../ai-logic-matchers.js';
import type {
  Args,
  InvalidArguments,
  MethodRecord,
  MethodValidationContext,
} from '../../method-types.js';

/** Refuse a response whose payload does not carry its declared type's shape. */
function refusePayloadMismatch(args: Args, ctx: MethodValidationContext): InvalidArguments | null {
  const response = (args.response ?? {}) as Args;
  const type = response.type;
  const payload = response.payload;
  if (type === 'text' && typeof payload !== 'string') {
    return ctx.fail(
      'response.type is "text" but response.payload is not a string.',
      'Pass response.payload as a plain string for type "text".',
      'response.payload',
    );
  }
  if (type === 'json' && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return ctx.fail(
      'response.type is "json" but response.payload is not a plain object.',
      'Pass response.payload as a plain object for type "json".',
      'response.payload',
    );
  }
  if (type === 'error') {
    const error = payload as Args;
    const hasShape =
      typeof error === 'object' && error !== null && typeof error.code === 'number' && typeof error.message === 'string';
    if (!hasShape) {
      return ctx.fail(
        'response.type is "error" but response.payload is not { code, message }.',
        'Pass response.payload as { code: <number>, message: <string> } for type "error".',
        'response.payload',
      );
    }
  }
  return null;
}

export default {
  tool: 'ai_logic',
  method: 'script',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'script(match{substring?, model?}, response{type: text|json|error, payload})',
  description:
    'Register one deterministic response on the local scripted answer engine, matched by prompt substring, by model, or both. Never sends a prompt anywhere, and refused when a different engine is configured.',
  args: z.object({ match: scriptMatchArgument, response: scriptResponseArgument }),
  operation: 'script_ai_logic',
  example: {
    match: { substring: 'archive status' },
    response: { type: 'text', payload: 'The archive is offline for maintenance.' },
  },
  validate: (args, ctx) => refusePayloadMismatch(args, ctx),
  async handler(args, ctx) {
    const match = (args.match ?? {}) as ScriptMatch;
    const response = args.response as ScriptResponse;
    const matcher = matcherFor(match);
    try {
      scriptEngine(aiFor(ctx), [
        matcher === undefined ? { respond: respondFor(response) } : { match: matcher, respond: respondFor(response) },
      ]);
    } catch (error) {
      if (!(error instanceof AIError) || error.code !== AIErrorCode.UNSUPPORTED) throw error;
      return operationFailure(error.message);
    }
    const on: string[] = [];
    if (match.substring !== undefined) on.push(`prompts containing '${match.substring}'`);
    if (match.model !== undefined) on.push(`model '${match.model}'`);
    const scope = on.length > 0 ? ` for ${on.join(' and ')}` : ', unconditional';
    return {
      ok: true,
      summary: `Registered a scripted ${response.type} response${scope}.`,
      data: {},
    };
  },
} satisfies MethodRecord;
