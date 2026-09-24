/**
 * ─── Scenario: stdlib-timestamp-duration ────────────────────────────────────
 * Timestamp and Duration values in Storage rules: the timestamp accessors on
 * `request.time` and the `resource` time fields, `date()`/`time()`, timestamp
 * and duration arithmetic, the `duration.*` constructors, and
 * `is timestamp`/`is duration`.
 *
 * `seconds()` and `nanos()` on a timestamp are time-of-day components, like
 * `hours()` and `minutes()`: the seconds of the minute and the nanoseconds of
 * the second. `toMillis()` is the only epoch accessor. The paired
 * seconds-of-minute and epoch-seconds cases and a pre-epoch timestamp separate
 * the two readings.
 *
 * Negative controls pin the type boundary: an int (`resource.size`) has no
 * timestamp methods, and a timestamp does not compare with an int. A model
 * that stores times as bare millisecond numbers answers both of those with a
 * value instead of an error.
 */
import type { StorageScenarioRecord } from './types.ts';

const REQUEST_TIME = '2025-06-15T13:45:30.250Z';

const existingObject = {
  size: 10,
  contentType: 'text/plain',
  timeCreated: '2025-06-15T12:00:00Z',
  updated: '2025-06-15T13:00:00Z',
};

function getCase(description: string, expectation: 'ALLOW' | 'DENY', path: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path,
    existingResource: existingObject,
    requestTime: REQUEST_TIME,
  };
}

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-STDLIB-TIME',
  rationale:
    'Timestamp and Duration are typed values in production Storage rules: accessors, date()/time(), pre-epoch seconds and nanos, arithmetic, constructors, and type tests, with int receivers and int comparisons as negative controls.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /accessors/{id} {
      allow get: if request.time.year() == 2025 && request.time.month() == 6
        && request.time.day() == 15 && request.time.hours() == 13
        && request.time.minutes() == 45 && request.time.dayOfWeek() == 7
        && request.time.dayOfYear() == 166;
    }
    match /seconds-of-minute/{id} {
      allow get: if request.time.seconds() == 30;
    }
    match /epoch-seconds/{id} {
      allow get: if request.time.seconds() == 1749995130;
    }
    match /nanos-of-second/{id} {
      allow get: if request.time.nanos() == 250000000;
    }
    match /to-millis/{id} {
      allow get: if request.time.toMillis() == 1749995130250;
    }
    match /date-and-time/{id} {
      allow get: if request.time.date() == timestamp.date(2025, 6, 15)
        && request.time.time() == duration.time(13, 45, 30, 250000000);
    }
    match /pre-epoch-parts/{id} {
      allow get: if timestamp.value(-1500).year() == 1969
        && timestamp.value(-1500).seconds() == 58
        && timestamp.value(-1500).nanos() == 500000000
        && timestamp.value(-1500).toMillis() == -1500;
    }
    match /difference/{id} {
      allow get: if request.time - resource.timeCreated == duration.value(6330250, 'ms');
    }
    match /window/{id} {
      allow get: if request.time > resource.timeCreated + duration.value(1, 'h')
        && request.time < resource.timeCreated + duration.value(2, 'h')
        && request.time - duration.value(1, 'd') < resource.timeCreated;
    }
    match /updated/{id} {
      allow get: if resource.updated.hours() == 13
        && resource.updated.date() == resource.timeCreated.date();
    }
    match /durations/{id} {
      allow get: if duration.value(90, 'm').seconds() == 5400
        && duration.value(1500, 'ms').nanos() == 500000000
        && duration.time(1, 30, 0, 5).nanos() == 5
        && duration.abs(duration.value(-3, 's')) == duration.value(3, 's')
        && duration.value(1, 'h') + duration.value(30, 'm') == duration.value(90, 'm')
        && duration.value(1, 'm') > duration.value(59, 's');
    }
    match /types/{id} {
      allow get: if request.time is timestamp
        && duration.value(1, 's') is duration
        && !(request.time is int);
    }
    match /int-receiver/{id} {
      allow get: if resource.size.hours() == 0;
    }
    match /int-receiver-absorbed/{id} {
      allow get: if resource.size.year() == 1970 || true;
    }
    match /timestamp-versus-int/{id} {
      allow get: if !(request.time < 0);
    }
  }
}`,
  cases: [
    getCase('timestamp accessors on request.time', 'ALLOW', 'accessors/a'),
    getCase('seconds() is the seconds of the minute', 'ALLOW', 'seconds-of-minute/a'),
    getCase('seconds() is not the epoch seconds', 'DENY', 'epoch-seconds/a'),
    getCase('nanos() is the nanoseconds of the second', 'ALLOW', 'nanos-of-second/a'),
    getCase('toMillis() is the epoch milliseconds', 'ALLOW', 'to-millis/a'),
    getCase('date() and time() return a timestamp and a duration', 'ALLOW', 'date-and-time/a'),
    getCase('pre-epoch timestamp components', 'ALLOW', 'pre-epoch-parts/a'),
    getCase('timestamp minus timestamp is a duration', 'ALLOW', 'difference/a'),
    getCase('timestamp plus and minus duration compare as timestamps', 'ALLOW', 'window/a'),
    getCase('resource.updated and resource.timeCreated are timestamps', 'ALLOW', 'updated/a'),
    getCase('duration constructors, accessors, arithmetic, and comparison', 'ALLOW', 'durations/a'),
    getCase('is timestamp and is duration type tests', 'ALLOW', 'types/a'),
    getCase('int receiver has no hours() method', 'DENY', 'int-receiver/a'),
    getCase('int receiver year() error under || true', 'ALLOW', 'int-receiver-absorbed/a'),
    getCase('timestamp compared with int is an error', 'DENY', 'timestamp-versus-int/a'),
  ],
};
