import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'oracle-backed',
  api: 'getAppCheck().verifyToken(token, { consume: true })',
  featureKeys: ['verifyToken'],
  behavior: 'The first consume resolves with `alreadyConsumed: false`, a second consume with `alreadyConsumed: true`, and a plain verify afterwards has no `alreadyConsumed` key.',
  evidence: 'capture `app-check-admin-verify-consume`.',
  observations: ['app-check-admin-verify-consume'],
  notes: 'The sandbox owns and persists the consumed set across the in-page, SharedWorker, and Node host planes, so restarts and sibling processes on one dev server share it.',
});
