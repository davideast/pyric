import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'When an ancestor write creates an exact matched descendant, the event snapshot is projected to that descendant rather than the ancestor object.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-descendant-projection.json`; leaf snapshot excluded its sibling.',
  observations: ['functions-rtdb-onvaluecreated-descendant-projection'],
});
