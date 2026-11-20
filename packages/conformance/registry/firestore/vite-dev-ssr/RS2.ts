import { row } from './section.ts';

export default row({
  order: 10,
  section: 'Server-rendered modules under vite dev',
  featureKeys: ['getFirestore'],
  api: 'getFirestore(app) in a server-rendered module under vite dev',
  behavior:
    "On a hosted dev server, `firebase/firestore` in a server-rendered module reads and writes the host's documents under its rules as the SSR session's user: a write the rules deny for that user fails with `permission-denied`. `ssrLoadModule`, the environment runner and every `ssr.noExternal` setting share one app and one session. On a SharedWorker dev server every call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`. No call reaches production or an in-process sandbox.",
  statusNote:
    'one SSR session per dev server process, as one Node server process has one auth state; per-request identity (`initializeServerApp`) is unsupported',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: ['firestore-rules-write-and-cross-doc-verdicts'],
  evidence:
    "Oracle `firestore-rules-write-and-cross-doc-verdicts` is replayed across `server.ssrLoadModule` (`ssr.noExternal: ['firebase']`) on a hosted Vite dev server in `firestore-vite-ssr.test.ts`, verifying unauthenticated, `$uid`, cross-document `exists()`/`get()`, `request.resource.data`, custom-claim, and merged `updateDoc` rules verdicts, shared SSR app/session identity across module loads, clean process exit on `server.close()`, and SharedWorker `failed-precondition` refusal naming `pyric({ hosted: true })`. App scenario `test/apps/vite-ssr-client-sdk`, `vite-module-swap.test.ts`, `vite-ssr-activation.test.ts`, and `vite-plugin-firestore.test.ts` pin the end-to-end and unit paths.",
  conformanceTests: [
    'packages/cli/test/serve/worker/oracle-captures/firestore-vite-ssr.test.ts',
    'test/apps/vite-ssr-client-sdk/scenario.ts',
    'packages/cli/test/serve/vite-module-swap.test.ts',
    'packages/cli/test/serve/vite-ssr-activation.test.ts',
    'packages/cli/test/serve/vite-plugin-firestore.test.ts',
  ],
});
