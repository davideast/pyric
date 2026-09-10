/**
 * The `ai_logic` tool's argument vocabulary.
 *
 * `script` names one scripted response on the local scripted answer engine.
 * `match` narrows which prompt the entry answers: `substring` checks the last
 * user turn's text, `model` checks the model the call names, and either or
 * both may be set; an entry with neither is unconditional and answers the
 * next unmatched call. `response` carries the answer: `payload` is a plain
 * string for `text`, a plain object for `json`, and `{ code, message }` for
 * `error`, and the two must agree, which `script`'s own validator enforces.
 */
import { z } from 'zod';

export const scriptMatchArgument = z
  .object({
    substring: z
      .string()
      .optional()
      .describe('Matches when the last user turn contains this text.'),
    model: z
      .string()
      .optional()
      .describe('Matches when the call names this model, with or without the models/ prefix.'),
  })
  .describe('Which call this entry answers. Neither field set means unconditional, next in queue.');

export const scriptResponseArgument = z
  .object({
    type: z.enum(['text', 'json', 'error']).describe('The shape payload is read as.'),
    payload: z
      .unknown()
      .describe(
        'A string for type "text", a plain object for type "json", or { code, message } for type "error".',
      ),
  })
  .describe('The answer this entry gives, once it matches.');
