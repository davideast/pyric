import type { ObservationException } from './types.ts';

export const exception: ObservationException = {
  reason: 'Real-resource IAM-disabled baseline: executed Firestore lookups deny while a short-circuited lookup rule allows. This records the permission boundary rather than enabled lookup-budget conformance.',
  until: 'The disabled-IAM observation is retired or replaced as negative permission-boundary evidence.',
};
