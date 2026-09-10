/**
 * Shared shapes and matcher construction for the `ai_logic` methods:
 * `script` builds a {@link ScriptMatcher} from `match{substring?, model?}`,
 * and `scripts` reads one back for display. A predicate matcher this module
 * built carries its own `{substring?, model?}` descriptor as a property on
 * the function, so listing never has to guess at an opaque closure.
 */
import type { GenerateContentRequest, ScriptMatcher } from 'pyric/ai/scripting';

export interface ScriptMatch {
  substring?: string;
  model?: string;
}

export type ScriptResponse =
  | { type: 'text'; payload: string }
  | { type: 'json'; payload: Record<string, unknown> }
  | { type: 'error'; payload: { code: number; message: string } };

/** A predicate matcher this module built, carrying the match it was built from. */
type DescribedMatcher = ((req: GenerateContentRequest, model?: string) => boolean) & {
  aiLogicMatch: ScriptMatch;
};

/** `models/x` and `x` name the same model for matching purposes. */
export function bareModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

/** All text a request's contents carry, the way the scripted engine reads it. */
function allText(req: GenerateContentRequest): string {
  return (req.contents ?? []).flatMap((content) => content.parts ?? []).map((part) => part.text ?? '').join('');
}

function tag(fn: (req: GenerateContentRequest, model?: string) => boolean, match: ScriptMatch): DescribedMatcher {
  return Object.assign(fn, { aiLogicMatch: match });
}

/** The matcher `match` spells, or `undefined` for an unconditional entry. */
export function matcherFor(match: ScriptMatch): ScriptMatcher | undefined {
  const { substring, model } = match;
  if (substring !== undefined && model !== undefined) {
    return tag((req, requestedModel) => {
      const namesModel = requestedModel !== undefined && bareModel(requestedModel) === bareModel(model);
      return allText(req).includes(substring) && namesModel;
    }, match);
  }
  if (model !== undefined) {
    return tag(
      (_req, requestedModel) => requestedModel !== undefined && bareModel(requestedModel) === bareModel(model),
      match,
    );
  }
  return substring;
}

/** What `match` reduces to for display: `null` for an unconditional entry. */
export function describeMatch(match: ScriptMatcher | undefined): ScriptMatch | { pattern: string } | null {
  if (match === undefined) return null;
  if (typeof match === 'string') return { substring: match };
  if (match instanceof RegExp) return { pattern: match.source };
  const described = (match as Partial<DescribedMatcher>).aiLogicMatch;
  return described ?? {};
}

/** The broker's shorthand shape for one scripted response. */
export function respondFor(
  response: ScriptResponse,
): { text: string } | { json: Record<string, unknown> } | { error: { code: number; message: string; status: string } } {
  if (response.type === 'text') return { text: response.payload };
  if (response.type === 'json') return { json: response.payload };
  return { error: { code: response.payload.code, message: response.payload.message, status: 'INVALID_ARGUMENT' } };
}

/** What one scripted response reduces to for display. */
export function describeRespond(respond: unknown): { type: string; payload: unknown } {
  const shape = respond as Record<string, unknown>;
  if ('text' in shape) return { type: 'text', payload: shape.text };
  if ('json' in shape) return { type: 'json', payload: shape.json };
  if ('error' in shape) {
    const error = shape.error as { code: number; message: string };
    return { type: 'error', payload: { code: error.code, message: error.message } };
  }
  return { type: 'raw', payload: shape };
}
