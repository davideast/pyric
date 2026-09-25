import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

// ─── request.time + timestamp constructors ───────────────────────
//
// `request.time` is the request's evaluation moment. Rules compare it
// against `timestamp.date(y,m,d)` (UTC midnight) and
// `timestamp.value(epochMillis)`. The caller injects the time (3rd arg);
// it defaults to now at evaluation.

describe('evaluateStorageRules — request.time', () => {
  const path = 'b/pyric-default/o/docs/d1.json';

  function evalTime(cond: string, now: Date): boolean {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(
      rules,
      { request: { auth: { uid: 'alice' }, method: 'read', path }, resource: { size: 1 } },
      now,
    ).allowed;
  }

  it('allows when request.time is before timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2026-07-10T00:00:00Z'))).toBe(true);
  });

  it('denies when request.time is after timestamp.date deadline', () => {
    expect(evalTime('request.time < timestamp.date(2030, 1, 1)', new Date('2031-01-01T00:00:00Z'))).toBe(false);
  });

  it('compares request.time against timestamp.value(epochMillis)', () => {
    const cutoff = Date.UTC(2028, 0, 1);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff - 1000))).toBe(true);
    expect(evalTime(`request.time < timestamp.value(${cutoff})`, new Date(cutoff + 1000))).toBe(false);
  });

  it('defaults request.time to now when the caller omits it', () => {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if request.time < timestamp.date(2100, 1, 1); }
      }
    }`);
    const r = evaluateStorageRules(rules, {
      request: { auth: { uid: 'alice' }, method: 'read', path },
      resource: { size: 1 },
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── Timestamp and Duration values ───────────────────────────────
//
// Production types `request.time` and the resource time fields as
// timestamps and `duration.*` as durations. Values replay corpus scenario
// stdlib-timestamp-duration (rules-storage-stdlib-timestamp-duration).

describe('evaluateStorageRules — timestamp and duration methods', () => {
  const path = 'b/pyric-default/o/docs/d1.json';
  const requestTime = new Date('2025-06-15T13:45:30.250Z');

  function evalTime(cond: string): { allowed: boolean; reasons: string[] } {
    const rules = parseStorageRules(`service firebase.storage {
      match /b/{bucket}/o {
        match /docs/{docId} { allow read: if ${cond}; }
      }
    }`);
    return evaluateStorageRules(
      rules,
      {
        request: { auth: { uid: 'alice' }, method: 'read', path },
        resource: { size: 10, timeCreated: '2025-06-15T12:00:00Z', updated: '2025-06-15T13:00:00Z' },
      },
      requestTime,
    );
  }

  it('reads the UTC date and time-of-day components of request.time', () => {
    expect(evalTime(
      'request.time.year() == 2025 && request.time.month() == 6 && request.time.day() == 15'
        + ' && request.time.hours() == 13 && request.time.minutes() == 45'
        + ' && request.time.dayOfWeek() == 7 && request.time.dayOfYear() == 166',
    ).allowed).toBe(true);
  });

  it('reads seconds() as the seconds of the minute and toMillis() as the epoch value', () => {
    expect(evalTime('request.time.seconds() == 30').allowed).toBe(true);
    expect(evalTime('request.time.seconds() == 1749995130').allowed).toBe(false);
    expect(evalTime('request.time.nanos() == 250000000').allowed).toBe(true);
    expect(evalTime('request.time.toMillis() == 1749995130250').allowed).toBe(true);
  });

  it('reads the components of a pre-epoch timestamp', () => {
    expect(evalTime(
      'timestamp.value(-1500).year() == 1969 && timestamp.value(-1500).seconds() == 58'
        + ' && timestamp.value(-1500).nanos() == 500000000',
    ).allowed).toBe(true);
  });

  it('returns a timestamp from date() and a duration from time()', () => {
    expect(evalTime(
      'request.time.date() == timestamp.date(2025, 6, 15)'
        + ' && request.time.time() == duration.time(13, 45, 30, 250000000)',
    ).allowed).toBe(true);
  });

  it('subtracts timestamps into a duration', () => {
    expect(evalTime("request.time - resource.timeCreated == duration.value(6330250, 'ms')").allowed).toBe(true);
  });

  it('adds and subtracts a duration from a timestamp', () => {
    expect(evalTime(
      "request.time > resource.timeCreated + duration.value(1, 'h')"
        + " && request.time < resource.timeCreated + duration.value(2, 'h')"
        + " && request.time - duration.value(1, 'd') < resource.timeCreated",
    ).allowed).toBe(true);
  });

  it('builds durations with duration.value, duration.time, and duration.abs', () => {
    expect(evalTime(
      "duration.value(90, 'm').seconds() == 5400 && duration.value(1500, 'ms').nanos() == 500000000"
        + ' && duration.time(1, 30, 0, 5).nanos() == 5'
        + " && duration.abs(duration.value(-3, 's')) == duration.value(3, 's')"
        + " && duration.value(1, 'h') + duration.value(30, 'm') == duration.value(90, 'm')"
        + " && duration.value(1, 'm') > duration.value(59, 's')",
    ).allowed).toBe(true);
  });

  it('denies a duration unit production does not accept', () => {
    const r = evalTime("duration.value(1, 'y') > duration.value(0, 's')");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('unknown unit');
  });

  it('gives an int no timestamp methods', () => {
    const r = evalTime('resource.size.hours() == 0');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Function not found error: Name: [hours].');
  });

  it('absorbs a timestamp method on an int under || true, as production does', () => {
    expect(evalTime('resource.size.year() == 1970 || true').allowed).toBe(true);
  });

  it('denies an argument to a timestamp accessor', () => {
    const r = evalTime('request.time.year(1) == 2025');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('year() expects no arguments');
  });
});
