import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'One multi-location update that creates multiple wildcard-matched children produces one create delivery for each child.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one update delivered delta and gamma.',
  observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
});
