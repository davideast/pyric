/**
 * ─── Scenario: duration-and-latlng ────────────────────────────────────────────
 * The geo/temporal value constructors and their accessors:
 * latlng.value(lat, lng) with .latitude()/.longitude()/.distance(), and
 * duration.value/time/abs. A `checkins` write that bounds a coordinate and a
 * session duration — exercising the LatLng and Duration surface against
 * production so the simulator's implementations are verdict-checked.
 */
import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  fm: 'Coverage: LatLng + Duration',
  rationale:
    'Production must accept latlng.value(...).latitude()/.longitude()/.distance() and duration.value/time/abs in a coordinate/duration-bounded write.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /checkins/{checkinId} {
      allow create: if request.auth != null
        && latlng.value(request.resource.data.lat, request.resource.data.lng).latitude() >= -90
        && latlng.value(request.resource.data.lat, request.resource.data.lng).longitude() >= -180
        && latlng.value(request.resource.data.lat, request.resource.data.lng)
             .distance(latlng.value(0, 0)) >= 0
        && duration.time(1, 0, 0, 0) > duration.value(0, 's')
        && duration.abs(duration.value(-5, 's')) > duration.value(0, 's');
    }
  }
}`,
  cases: [
    {
      description: 'valid coordinate and durations ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'checkins/c1',
      auth: { uid: 'alice' },
      data: { lat: 37.42, lng: -122.08 },
    },
    {
      description: 'latitude below -90 DENY (LatLng.latitude bound)',
      expectation: 'DENY',
      method: 'create',
      path: 'checkins/c2',
      auth: { uid: 'alice' },
      data: { lat: -100, lng: -122.08 },
    },
  ],
  group: 'stress',
};
