/**
 * ─── Scenario: time-math-and-casts ────────────────────────────────────────────
 * The request.time Timestamp accessor family (year/month/day/hours/minutes/
 * seconds/nanos/dayOfWeek/dayOfYear/toMillis/date/time), the math.* builtins
 * (floor/round/sqrt/pow/isNaN), the numeric/string type casts (int/float/string),
 * request.method, and the `>=` / `*` operators — the arithmetic and temporal
 * surface a validation-heavy `events` write leans on. request.time is pinned via
 * `requestTime` so the temporal assertions are deterministic across runs.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: Timestamp methods + math builtins + casts',
  rationale:
    'Production must accept request.time.<accessor>() Timestamp methods, math.floor/round/sqrt/pow/isNaN, int/float/string casts, request.method, and >= / * operators.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eventId} {
      allow create: if request.auth != null
        && request.method == 'create'
        && request.time.year() >= 2020
        && request.time.month() >= 1
        && request.time.day() >= 1
        && request.time.hours() >= 0
        && request.time.minutes() >= 0
        && request.time.seconds() >= 0
        && request.time.nanos() >= 0
        && request.time.dayOfWeek() >= 1
        && request.time.dayOfYear() >= 1
        && request.time.toMillis() > 0
        && request.time.date() == request.time.date()
        && request.time.time() == request.time.time()
        && math.floor(request.resource.data.score) >= 0
        && math.round(request.resource.data.score) >= 0
        && math.sqrt(request.resource.data.area) >= 0
        && math.pow(request.resource.data.base, 2) >= 0
        && math.isNaN(request.resource.data.score) == false
        && int(request.resource.data.countStr) >= 0
        && float(request.resource.data.countStr) >= 0
        && string(request.resource.data.score).size() >= 1
        && request.resource.data.qty * 2 >= 2;
    }
  }
}`,
  cases: [
    {
      description: 'valid event within all bounds ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'events/e1',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: 9, base: 3, countStr: '5', qty: 2 },
    },
    {
      description: 'qty too small so qty*2 < 2 DENY (mul + gte)',
      expectation: 'DENY',
      method: 'create',
      path: 'events/e2',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: 9, base: 3, countStr: '5', qty: 0 },
    },
    {
      description: 'negative area so sqrt precondition fails DENY (math.sqrt)',
      expectation: 'DENY',
      method: 'create',
      path: 'events/e3',
      auth: { uid: 'alice' },
      requestTime: '2023-06-15T12:30:45.000Z',
      data: { score: 4, area: -1, base: 3, countStr: '5', qty: 2 },
    },
  ],
  group: 'stress',
};
