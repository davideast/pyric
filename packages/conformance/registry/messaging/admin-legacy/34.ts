import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['MessagingOptions'],
  flipped: 'type-backed',
  exceptionReason:
    'Pure TypeScript type definition exported from firebase-admin/messaging; legacy sendToDevice and sendToTopic methods were removed in firebase-admin v13, so no runtime carrier or production behavior exists to capture (closed structurally by TypeScript type assignability).',
  api: 'interface MessagingOptions { dryRun?; priority?; timeToLive?; collapseKey?; mutableContent?; contentAvailable?; restrictedPackageName?; [key] }',
  behavior:
    'Legacy send options; documented defaults are dryRun false, ttl 2419200s (4 weeks), priority high for notifications / normal for data.',
  evidence:
    'Upstream typings (firebase-admin 13.10.0 `messaging-api`); pure TypeScript interface closed by structural type assignability.',
});
