import { row } from './section.ts';

export default row({
  order: 30,
  behavior: 'Honors `maxDownloadSize` same as `getBytes`',
  evidence:
    '`unit:upstream-storage-probes.test.ts` ("getBytes / getBlob return a truncated prefix when the object exceeds the cap"; shared `fetchBlob` helper in `download.ts`)',
  automation: 'unit-backed',
  conformanceTests: ['packages/pyric/test/storage/upstream-storage-probes.test.ts'],
  exceptionReason:
    'Upstream @firebase/storage exports a throwing Node stub for getBlob and relies on browser XMLHttpRequest in its web build, preventing headless Node production capture.',
});
