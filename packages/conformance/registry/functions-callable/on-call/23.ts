import { SUITE, VITE_PLANE, WIRE_SERVING, row } from './section.ts';

export default row({
  order: 230,
  kind: 'pyric',
  api: 'onCall execution record',
  behavior:
    'Each call a callable serves prints one execution line naming the export, the callable kind, the HTTP status, and the duration; a streamed call prints one line when its stream ends.',
  evidence:
    'Pyric-owned, extending functions-http#21 (`packages/cli/src/functions/http/report.ts` and `gateway.ts`); both `pyric sandbox` and the Vite plugin print one `callable` line per call when the response finishes, skipping CORS OPTIONS preflights.',
  flip: { status: 'conforms', tests: [SUITE, WIRE_SERVING, VITE_PLANE] },
});
