import { describe, expect, test } from 'bun:test';
import {
  isValidScheduleExpression,
  parseScheduleExpression,
} from '../../src/functions/scheduler/schedule-expression.js';

describe('parseScheduleExpression', () => {
  test('accepts standard 5-field Unix crontab expressions and Cloud Scheduler macros', () => {
    const validCrons = [
      '0 * * * *',
      '*/15 9-17 * * 1-5',
      '0 0 1 jan,jul *',
      '30 4 * * mon-fri',
      '0 12 * * mon-sun',
      '0 0 * * 0',
      '0 0 * * 7',
      '5/20 0-23/2 1-15 * *',
      '@daily',
      '@hourly',
      '@weekly',
      '@monthly',
      '@yearly',
      '@annually',
      '@midnight',
    ];

    for (const expr of validCrons) {
      const result = parseScheduleExpression(expr);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parsed.kind).toBe('cron');
      }
      expect(isValidScheduleExpression(expr)).toBe(true);
    }
  });

  test('parses App Engine every N minutes|hours expressions into millisecond intervals', () => {
    const fiveMin = parseScheduleExpression('every 5 minutes');
    expect(fiveMin).toEqual({
      ok: true,
      parsed: {
        kind: 'interval',
        expression: 'every 5 minutes',
        value: 5,
        unit: 'minutes',
        intervalMs: 300_000,
      },
    });

    const singleHour = parseScheduleExpression('every 1 hour synchronized');
    expect(singleHour).toEqual({
      ok: true,
      parsed: {
        kind: 'interval',
        expression: 'every 1 hour synchronized',
        value: 1,
        unit: 'hours',
        intervalMs: 3_600_000,
      },
    });

    const windowed = parseScheduleExpression('every 15 mins from 09:00 to 17:30');
    expect(windowed).toEqual({
      ok: true,
      parsed: {
        kind: 'interval',
        expression: 'every 15 mins from 09:00 to 17:30',
        value: 15,
        unit: 'minutes',
        intervalMs: 900_000,
      },
    });

    const calendar = parseScheduleExpression('every monday, wednesday 08:30');
    expect(calendar).toEqual({
      ok: true,
      parsed: {
        kind: 'appengine-calendar',
        expression: 'every monday, wednesday 08:30',
      },
    });
  });

  test('rejects malformed cron field counts, out-of-range values, and invalid App Engine strings', () => {
    const invalidSchedules = [
      '',
      '   ',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 0 *',
      '* * * 13 *',
      '* * * * 8',
      '10-5 * * * *',
      '*/0 * * * *',
      '*/60 * * * *',
      '1/2/3 * * * *',
      ', * * * *',
      'every 0 minutes',
      'every -5 hours',
      'every 10 seconds',
      'every 5 minutes from 25:00 to 17:00',
      'every 5 minutes bogus qualifier',
      'every funday 09:00',
      'not a valid schedule',
    ];

    for (const invalid of invalidSchedules) {
      const result = parseScheduleExpression(invalid);
      expect(result.ok).toBe(false);
      expect(isValidScheduleExpression(invalid)).toBe(false);
    }
  });

  test('handles case-insensitive month/weekday names, Sunday 0/7 equivalence, and leading/trailing whitespace', () => {
    expect(parseScheduleExpression('  15 6 * JAN,JUN,DEC MON-FRI  ')).toEqual({
      ok: true,
      parsed: {
        kind: 'cron',
        expression: '15 6 * JAN,JUN,DEC MON-FRI',
      },
    });
    expect(parseScheduleExpression('0 0 * * SUN')).toEqual({
      ok: true,
      parsed: {
        kind: 'cron',
        expression: '0 0 * * SUN',
      },
    });
    expect(parseScheduleExpression('every 2 hours   ')).toEqual({
      ok: true,
      parsed: {
        kind: 'interval',
        expression: 'every 2 hours',
        value: 2,
        unit: 'hours',
        intervalMs: 7_200_000,
      },
    });
    // Descending numeric weekday range (5-1) is rejected even though mon-sun is allowed.
    expect(parseScheduleExpression('0 0 * * 5-1').ok).toBe(false);
  });
});
