import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'Sequential creates are all delivered; their observed arrival order is evidence, not an ordering guarantee.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; all three arrived in observed order 2, 1, 3.',
  observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
});
