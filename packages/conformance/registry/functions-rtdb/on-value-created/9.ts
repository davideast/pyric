import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["DatabaseEvent"],
  flipped: 'oracle-backed',
  api: 'DatabaseEvent.data.ref',
  behavior:
    'The snapshot ref is an Admin DatabaseReference rooted at the matched path and can perform an awaited write from the handler.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; matched Admin ref completed the awaited sibling write.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
