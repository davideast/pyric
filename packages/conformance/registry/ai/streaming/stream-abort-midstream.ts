import { row } from './section.ts';

export default row({
  order: 75,
  featureKeys: ['generateContentStream'],
  api: 'generateContentStream(request, { signal })',
  behavior:
    'Aborting `SingleRequestOptions.signal` mid-stream stops chunk delivery, cancels the underlying stream and upstream request, and rejects `stream` and `response` with `AbortError`',
  automation: 'unit-backed',
  evidence:
    '`unit:stream-abort-and-refusal.test.ts` test `ai#stream-abort-midstream` plus worker-host test `ai-stream-abort-and-refusal.test.ts` and app scenario `test/apps/ai-stream-abort`',
  conformanceTests: ['stream-abort-and-refusal.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-stream-abort-and-refusal.test.ts',
    'test/apps/ai-stream-abort/scenario.ts',
  ],
  notes:
    'Covers mid-stream cancellation after reading initial chunks and before the first chunk across in-process, in-page, SharedWorker, and Node host planes (#1633).',
});
