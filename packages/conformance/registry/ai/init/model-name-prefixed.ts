import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["getGenerativeModel"],
  api: 'getGenerativeModel(ai, modelParams)',
  behavior: 'A `models/`-prefixed name is accepted without double prefixing',
  status: 'diverged-documented',
  statusNote: 'normalization',
  automation: 'unit-backed',
  evidence: '`unit:instances.test.ts` test `ai#model-name-prefixed` (no capture; normalization claim)',
  conformanceTests: ['instances.test.ts'],
  notes: 'Pinned delta vs installed 2.12.0: the installed AIModel double-prefixes an already `models/`-prefixed name; the mirror normalizes without the wart (packages/pyric/src/ai/models.ts).',
});
