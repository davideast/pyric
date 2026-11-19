import { row } from './section.ts';

export default row({
  order: 100,
  diverged: 'by-design',
  api: 'getAppCheck().verifyToken(firebaseToken, { consume: true }) in production AI mode',
  featureKeys: ['verifyToken'],
  behavior: 'Production records consumption on Firebase\'s servers, once per project: the first consume resolves with `alreadyConsumed: false` and a second with `alreadyConsumed: true`. Sandbox: firebase-admin verifies the token without `consume`, and the mirror records it in the process, in the set it keeps for sandbox tokens, with the same `false` then `true` results.',
  evidence: 'capture `app-check-admin-verify-consume`; the sandbox side is pinned in the admin suite and the production AI mode app scenario.',
  observations: ['app-check-admin-verify-consume'],
  notes: 'Divergence, by design: production\'s consume is an authorized call that needs a credential with App Check permissions, and Pyric holds none. Forwarding it would write to production from a development loop. The record is lost on restart and each process keeps its own, as for sandbox tokens (#1297).',
});
