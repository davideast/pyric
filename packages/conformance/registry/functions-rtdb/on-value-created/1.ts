import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["onValueCreated"],
  flipped: 'oracle-backed',
  api: 'onValueCreated(ref, handler)',
  behavior:
    'A write that changes an exact matched RTDB location from absent to present invokes the handler once with a create CloudEvent and a DataSnapshot containing the created value.',
  evidence:
    'oracle: `functions-rtdb-onvaluecreated-exact-create.json` (firebase-functions 7.2.5); production exact-create behavior.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
