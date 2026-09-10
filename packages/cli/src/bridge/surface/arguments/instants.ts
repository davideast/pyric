/**
 * Refusing an argument that is meant to be an instant.
 *
 * Two arguments carry one: `rules.simulate`'s `requestTime` and
 * `sandbox.setClock`'s `isoTime`. They had the same check and the same message
 * written twice, which is two places for the accepted form to drift apart. An
 * agent correcting itself reads the message, so the message is the product and
 * there is one of it.
 */
import { quoted } from '../closest-name.js';
import type { Args, Fail, InvalidArguments } from '../method-types.js';

/** The form both arguments accept, spelled once. */
const ACCEPTED_FORM = `an ISO 8601 string, such as '2026-09-09T12:00:00.000Z'`;

/**
 * Refuse `field` when it holds something that does not parse as a date. An
 * absent value is not refused: whether the argument is required is the
 * schema's decision, not this check's.
 */
export function checkInstant(field: string, args: Args, fail: Fail): InvalidArguments | null {
  const value = args[field];
  if (value === undefined) return null;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return null;
  return fail(
    `${field} is ${quoted(value)}, which does not parse as a date.`,
    `Pass ${field} as ${ACCEPTED_FORM}.`,
    field,
  );
}
