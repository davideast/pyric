/**
 * Refusing an argument that is meant to be an instant.
 *
 * Two arguments carry one: `rules.simulate`'s `requestTime` and
 * `sandbox.setClock`'s `isoTime`. They had the same check and the same message
 * written twice, which is two places for the accepted form to drift apart. An
 * agent correcting itself reads the message, so the message is the product and
 * there is one of it.
 */
import { isClockInstantInRange } from 'pyric/sandbox';
import { quoted } from '../closest-name.js';
import type { Args, Fail, InvalidArguments } from '../method-types.js';

/** The form both arguments accept, spelled once. */
const ACCEPTED_FORM = `an ISO 8601 instant with Z or an explicit offset, such as '2026-09-09T12:00:00.000Z'`;

const ISO_INSTANT_WITH_ZONE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isGregorianLeapYear(year: number): boolean {
  const absoluteYear = Math.abs(year);
  return (absoluteYear % 4 === 0 && absoluteYear % 100 !== 0) || absoluteYear % 400 === 0;
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) {
    if (isGregorianLeapYear(year)) return 29;
    return 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseIsoInstantWithZone(value: string): { kind: 'valid' } | { kind: 'out-of-range' } | { kind: 'invalid' } {
  const match = ISO_INSTANT_WITH_ZONE.exec(value);
  if (match === null) return { kind: 'invalid' };

  const rawYear = match[1]!;
  const year = Number(rawYear);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return { kind: 'invalid' };
  if (day < 1 || day > daysInGregorianMonth(year, month)) return { kind: 'invalid' };
  if (hour < 0 || hour > 23) return { kind: 'invalid' };
  if (minute < 0 || minute > 59) return { kind: 'invalid' };
  if (second < 0 || second > 59) return { kind: 'invalid' };

  const zone = match[8];
  if (zone !== 'Z') {
    const offsetHours = Number(match[10]);
    const offsetMinutes = Number(match[11]);
    if (offsetHours < 0 || offsetHours > 23) return { kind: 'invalid' };
    if (offsetMinutes < 0 || offsetMinutes > 59) return { kind: 'invalid' };
  }

  const hasFourDigitYear = rawYear.length === 4 && year >= 1 && year <= 9999;
  if (!hasFourDigitYear) return { kind: 'out-of-range' };

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { kind: 'invalid' };
  if (!isClockInstantInRange(parsed)) return { kind: 'out-of-range' };
  return { kind: 'valid' };
}

/**
 * Refuse `field` when it holds something that is not an ISO 8601 instant with
 * an explicit timezone offset or `Z`, or falls outside the 0001..9999 timestamp
 * range every sandbox service supports. An absent value is not refused: whether
 * the argument is required is the schema's decision, not this check's.
 */
export function checkInstant(field: string, args: Args, fail: Fail): InvalidArguments | null {
  const value = args[field];
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const outcome = parseIsoInstantWithZone(value);
    if (outcome.kind === 'valid') return null;
    if (outcome.kind === 'out-of-range') {
      return fail(
        `${field} is ${quoted(value)}, which falls outside the supported timestamp range (0001-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z).`,
        `Pass ${field} as ${ACCEPTED_FORM} between years 0001 and 9999.`,
        field,
      );
    }
  }
  return fail(
    `${field} is ${quoted(value)}, which is not an ISO 8601 instant with Z or an explicit timezone offset.`,
    `Pass ${field} as ${ACCEPTED_FORM}.`,
    field,
  );
}
