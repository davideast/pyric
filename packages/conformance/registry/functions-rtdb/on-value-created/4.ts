import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'A named single-segment wildcard matches a created child and exposes the matched segment through event.params.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; production populated caseId and itemId.',
  observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
});
