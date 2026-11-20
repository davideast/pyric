import { row } from './section.ts';

export default row({
  order: 20,
  section: 'Server-rendered modules under vite dev',
  featureKeys: ['getFirestore'],
  api: 'firebase-admin/firestore in a server-rendered module under vite dev',
  behavior:
    "On a hosted dev server, `firebase-admin/firestore` in a server-rendered module reads and writes the dev server host's documents as admin, past the rules, as a `firebase-admin` process on the host does. On a SharedWorker dev server its first call fails with `failed-precondition` and a message naming `pyric({ hosted: true })`.",
  statusNote: "admin reads and writes bypass the rules, as firebase-admin's do",
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'firestore-admin-snapshot-and-reference-metadata',
    'firestore-rules-write-and-cross-doc-verdicts',
  ],
  evidence:
    "Oracles `firestore-admin-snapshot-and-reference-metadata` and `firestore-rules-write-and-cross-doc-verdicts` are replayed through bare `initializeApp()` under `attachViteSsrActivation` and `server.ssrLoadModule` in `firestore-vite-ssr.test.ts`, verifying admin document/query snapshot metadata, `WriteResult`, `FirebaseFirestoreError`, rule bypass seeding and reading SSR and browser documents past deny-all and user-scoped rules, and SharedWorker `failed-precondition` refusal naming `pyric({ hosted: true })`. App scenario `test/apps/vite-ssr-client-sdk` and `ambient-init.test.ts` pin the end-to-end and unit paths.",
  conformanceTests: [
    'packages/cli/test/serve/worker/oracle-captures/firestore-vite-ssr.test.ts',
    'test/apps/vite-ssr-client-sdk/scenario.ts',
    'packages/pyric-admin/test/app/ambient-init.test.ts',
  ],
});
