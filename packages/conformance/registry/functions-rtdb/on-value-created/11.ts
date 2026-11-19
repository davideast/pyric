import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, async handler)',
  behavior:
    'A Promise returned by the handler keeps the execution open through delayed asynchronous work and its awaited Admin write.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; capture logged only after the delayed Admin write completed.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
