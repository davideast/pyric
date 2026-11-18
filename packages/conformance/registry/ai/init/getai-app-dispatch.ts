import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getAI"],
  api: 'getAI(target)',
  behavior: 'After package resolution selects the mirror, `getAI(app)` uses the app\'s sandbox and the returned handle carries the app',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#getai-app-dispatch` (package-resolution dispatch claim)',
  conformanceTests: ['instances.test.ts'],
  notes: 'Production code keeps resolving firebase/ai; the pyric/ai module contains no production dispatch.',
});
