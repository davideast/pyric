import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'oracle-backed',
  api: 'getAppCheck().verifyToken(token, { consume: true })',
  featureKeys: ['verifyToken'],
  behavior: 'The first consume resolves with `alreadyConsumed: false`, a second consume with `alreadyConsumed: true`, and a plain verify afterwards has no `alreadyConsumed` key.',
  evidence: 'capture `app-check-admin-verify-consume`.',
  observations: ['app-check-admin-verify-consume'],
  notes: 'Covered: consumes through one sandbox handle in one process, including the require and import copies of `pyric-admin/app-check` (the consumed set sits behind `Symbol.for`). Not covered: production consumes once per project, server side, while the sandbox keeps the consumed set in process memory, so it is lost on restart and each process on one dev server keeps its own (#1297).',
});
