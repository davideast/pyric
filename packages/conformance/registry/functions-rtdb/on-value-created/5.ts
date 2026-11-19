import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'Creating an ancestor object invokes the wildcard handler once for each newly-present matching descendant.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one ancestor set delivered alpha and beta.',
  observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
});
