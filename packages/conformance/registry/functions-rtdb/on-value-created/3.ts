import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'A value that already exists when the trigger is deployed does not produce a historical create delivery.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-startup-existing.json`; pre-seeded value, zero delivery in the observation window.',
  observations: ['functions-rtdb-onvaluecreated-startup-existing'],
});
