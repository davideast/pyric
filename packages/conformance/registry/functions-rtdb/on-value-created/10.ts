import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["DatabaseEvent"],
  flipped: 'oracle-backed',
  api: 'DatabaseEvent.authType / authId',
  behavior:
    'For the production Admin SDK write, the event exposes authType `unknown` and authId `null`.',
  evidence: 'oracle: `functions-rtdb-onvaluecreated-exact-create.json`.',
  observations: ['functions-rtdb-onvaluecreated-exact-create'],
});
