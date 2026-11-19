import { SUITE, VITE_PLANE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 180,
  kind: 'pyric',
  api: 'firebase-admin inside onRequest',
  behavior:
    'A firebase-admin write the handler awaits is visible to a client of the same sandbox before the HTTP response arrives.',
  evidence:
    'The child runs with PYRIC_SANDBOX=remote:<serveUrl> and pre-initializes the ambient firebase-admin app; a bare initializeApp() returns it (`pyric-admin/src/app/index.ts:131-139`). Both planes: the suite and `packages/cli/test/functions-http/vite-plane.test.ts` read the document from the peer sandbox as soon as the response arrives.',
  flip: { status: 'conforms', tests: [SUITE, VITE_PLANE] },
});
