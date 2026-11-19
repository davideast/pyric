import { row } from './section.ts';

export default row({
  order: 10,
  behavior: 'Returns the stored bytes wrapped as a `Blob` (with `.type` from metadata)',
  evidence: '`unit:reference.test.ts` ("accepts a Blob and round-trips through getBlob")',
  risk: ['metadata'],
  riskScore: 1,
  riskReasons: ['asserts metadata shape'],
  automation: 'unit-backed',
  conformanceTests: ['packages/pyric/test/storage/reference.test.ts'],
  exceptionReason:
    'Upstream @firebase/storage exports a throwing Node stub for getBlob and relies on browser XMLHttpRequest in its web build, preventing headless Node production capture.',
});
