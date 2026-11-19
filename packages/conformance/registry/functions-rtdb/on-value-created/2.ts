import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'After the initial create delivery, changing or deleting that same matched value does not invoke an onValueCreated handler.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; update/delete produced no additional delivery in the bounded production scenario.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
