/**
 * Lightweight parser and validator for Cloud Scheduler / Firebase `onSchedule`
 * expressions: standard 5-field Unix crontab strings, Cloud Scheduler `@`
 * nicknames, and App Engine interval/calendar schedule strings.
 */

export type ParsedScheduleExpression =
  | {
      kind: 'cron';
      expression: string;
    }
  | {
      kind: 'interval';
      expression: string;
      value: number;
      unit: 'minutes' | 'hours';
      intervalMs: number;
    }
  | {
      kind: 'appengine-calendar';
      expression: string;
    };

export type ScheduleParseResult =
  | { ok: true; parsed: ParsedScheduleExpression }
  | { ok: false; reason: string };

const CRON_MACROS: ReadonlySet<string> = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DAY_OF_WEEK_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const APP_ENGINE_DAYS: ReadonlySet<string> = new Set([
  'day',
  'monday',
  'mon',
  'tuesday',
  'tue',
  'wednesday',
  'wed',
  'thursday',
  'thu',
  'friday',
  'fri',
  'saturday',
  'sat',
  'sunday',
  'sun',
]);

interface CronFieldBounds {
  name: string;
  min: number;
  max: number;
  names?: Readonly<Record<string, number>>;
  allowSundaySeven?: boolean;
}

const CRON_FIELDS: readonly CronFieldBounds[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  {
    name: 'day-of-week',
    min: 0,
    max: 7,
    names: DAY_OF_WEEK_NAMES,
    allowSundaySeven: true,
  },
];

function parsePositiveInt(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number(token);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function parseCronAtom(token: string, bounds: CronFieldBounds): number | null {
  const lower = token.toLowerCase();
  if (bounds.names !== undefined && Object.hasOwn(bounds.names, lower)) {
    const mapped = bounds.names[lower];
    if (mapped !== undefined) return mapped;
  }
  if (!/^\d+$/.test(token)) return null;
  const numeric = Number(token);
  if (!Number.isSafeInteger(numeric)) return null;
  if (numeric < bounds.min || numeric > bounds.max) return null;
  return numeric;
}

function validateCronSegment(segment: string, bounds: CronFieldBounds): string | null {
  if (segment.length === 0) {
    return `empty segment in ${bounds.name} field`;
  }
  const slashParts = segment.split('/');
  if (slashParts.length > 2) {
    return `invalid step syntax '${segment}' in ${bounds.name} field`;
  }
  const rangePart = slashParts[0] ?? '';
  const stepPart = slashParts[1];
  if (stepPart !== undefined) {
    const step = parsePositiveInt(stepPart);
    const maxStep = Math.max(1, bounds.max - bounds.min);
    if (step === null || step > maxStep) {
      return `invalid step '${stepPart}' in ${bounds.name} field`;
    }
  }

  if (rangePart === '*') {
    return null;
  }

  const dashParts = rangePart.split('-');
  if (dashParts.length === 1) {
    const value = parseCronAtom(rangePart, bounds);
    if (value === null) {
      return `value '${rangePart}' out of range for ${bounds.name} field`;
    }
    return null;
  }
  if (dashParts.length !== 2) {
    return `invalid range '${rangePart}' in ${bounds.name} field`;
  }

  const rawStart = dashParts[0] ?? '';
  const rawEnd = dashParts[1] ?? '';
  const start = parseCronAtom(rawStart, bounds);
  let end = parseCronAtom(rawEnd, bounds);
  if (start === null || end === null) {
    return `range '${rangePart}' out of bounds for ${bounds.name} field`;
  }
  if (bounds.allowSundaySeven === true && end === 0 && rawEnd.toLowerCase() === 'sun' && start > 0) {
    end = 7;
  }
  if (start > end) {
    return `descending range '${rangePart}' in ${bounds.name} field`;
  }
  return null;
}

function isValidTimeOfDay(token: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(token);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function parseAppEngineSchedule(trimmed: string): ScheduleParseResult {
  const intervalMatch =
    /^every\s+(-?\d+)\s+(minutes|mins|minute|min|hours|hour)(?:\s+(.*))?$/i.exec(trimmed);
  if (intervalMatch) {
    const rawCount = Number(intervalMatch[1]);
    if (!Number.isSafeInteger(rawCount) || rawCount < 1) {
      return { ok: false, reason: 'interval count must be a positive integer' };
    }
    const rawUnit = (intervalMatch[2] ?? '').toLowerCase();
    let unit: 'minutes' | 'hours' = 'hours';
    let unitMs = 3_600_000;
    if (rawUnit.startsWith('min')) {
      unit = 'minutes';
      unitMs = 60_000;
    }
    const suffix = intervalMatch[3]?.trim();
    if (suffix !== undefined && suffix.length > 0) {
      const isSynchronized = suffix.toLowerCase() === 'synchronized';
      const windowMatch = /^from\s+(\S+)\s+to\s+(\S+)$/i.exec(suffix);
      if (!isSynchronized) {
        if (!windowMatch) {
          return { ok: false, reason: `unsupported interval qualifier '${suffix}'` };
        }
        const fromTime = windowMatch[1] ?? '';
        const toTime = windowMatch[2] ?? '';
        if (!isValidTimeOfDay(fromTime) || !isValidTimeOfDay(toTime)) {
          return { ok: false, reason: `invalid interval window '${suffix}'` };
        }
      }
    }
    return {
      ok: true,
      parsed: {
        kind: 'interval',
        expression: trimmed,
        value: rawCount,
        unit,
        intervalMs: rawCount * unitMs,
      },
    };
  }

  const calendarMatch = /^every\s+([a-z,\s]+?)\s+(\d{2}:\d{2})$/i.exec(trimmed);
  if (calendarMatch) {
    const rawDays = (calendarMatch[1] ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    const timeToken = calendarMatch[2] ?? '';
    const daysValid = rawDays.length > 0 && rawDays.every((day) => APP_ENGINE_DAYS.has(day));
    if (daysValid && isValidTimeOfDay(timeToken)) {
      return {
        ok: true,
        parsed: { kind: 'appengine-calendar', expression: trimmed },
      };
    }
  }

  return {
    ok: false,
    reason: "expected 'every N minutes|hours' or 'every <day> HH:MM'",
  };
}

/** Parse and validate a Unix 5-field crontab or App Engine schedule string. */
export function parseScheduleExpression(schedule: string): ScheduleParseResult {
  const trimmed = schedule.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'schedule string cannot be empty' };
  }

  const lower = trimmed.toLowerCase();
  if (CRON_MACROS.has(lower)) {
    return {
      ok: true,
      parsed: { kind: 'cron', expression: trimmed },
    };
  }

  if (lower.startsWith('every ') || lower === 'every') {
    return parseAppEngineSchedule(trimmed);
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `expected 5 cron fields, got ${fields.length}`,
    };
  }

  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const bounds = CRON_FIELDS[index];
    const rawField = fields[index];
    if (bounds === undefined || rawField === undefined) continue;
    const segments = rawField.split(',');
    for (const segment of segments) {
      const error = validateCronSegment(segment, bounds);
      if (error !== null) {
        return { ok: false, reason: error };
      }
    }
  }

  return {
    ok: true,
    parsed: { kind: 'cron', expression: trimmed },
  };
}

/** Whether `schedule` is a valid Cloud Scheduler cron or App Engine expression. */
export function isValidScheduleExpression(schedule: string): boolean {
  return parseScheduleExpression(schedule).ok;
}
