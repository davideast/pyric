import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["DatabaseEvent"],
  flipped: 'oracle-backed',
  api: 'DatabaseEvent.data',
  behavior:
    'The delivered DataSnapshot exposes the created value, key, existence, JSON projection, child lookup, child count, and child enumeration.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; frozen val/key/exists/toJSON/child enumeration shape.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
