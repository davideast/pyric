/**
 * ─── Scenario: timestamp-component-accessors ────────────────────────────────
 * `seconds()` and `nanos()` on a timestamp are time-of-day components, like
 * `hours()` and `minutes()`: the seconds of the minute and the nanoseconds of
 * the second. `toMillis()` is the epoch accessor. The paired
 * seconds-of-minute and epoch-seconds cases and a pre-epoch timestamp separate
 * the component reading from an epoch-seconds reading.
 */
import type { ScenarioRecord } from './types.ts';

const REQUEST_TIME = '2025-06-15T13:45:30.250Z';

function getCase(description: string, expectation: 'ALLOW' | 'DENY', path: string) {
  return {
    description,
    expectation,
    method: 'get' as const,
    path,
    auth: { uid: 'alice' },
    resource: { title: 'X' },
    requestTime: REQUEST_TIME,
  };
}

export const scenario: ScenarioRecord = {
  fm: 'Timestamp accessors',
  rationale:
    'Timestamp seconds() and nanos() are the seconds-of-minute and nanoseconds-of-second components, not epoch values; toMillis() is the epoch accessor.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
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
    match /pre-epoch-parts/{id} {
      allow get: if timestamp.value(-1500).year() == 1969
        && timestamp.value(-1500).seconds() == 58
        && timestamp.value(-1500).nanos() == 500000000
        && timestamp.value(-1500).toMillis() == -1500;
    }
  }
}`,
  cases: [
    getCase('seconds() is the seconds of the minute', 'ALLOW', 'seconds-of-minute/a'),
    getCase('seconds() is not the epoch seconds', 'DENY', 'epoch-seconds/a'),
    getCase('nanos() is the nanoseconds of the second', 'ALLOW', 'nanos-of-second/a'),
    getCase('toMillis() is the epoch milliseconds', 'ALLOW', 'to-millis/a'),
    getCase('pre-epoch timestamp components', 'ALLOW', 'pre-epoch-parts/a'),
  ],
  group: 'fix-class',
};
