import { row } from './section.ts';

export default row({
  order: 40,
  api: 'resolveUrlCallableTarget() / resolveNamedCallableTarget() Cloud Run & customDomain routing',
  behavior: 'Rewrites legacy *.a.run.app and regional *.run.app URLs onto the local gateway with ?__pyric_run_service=1 and routes loopback customDomain Hosting rewrites.',
  featureKeys: ['resolveUrlCallableTarget', 'resolveNamedCallableTarget'],
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart` (resolves named callables onto emulator or local gateway and blocks off-machine customDomain; rewrites cloudfunctions.net and run.app URLs onto local gateway).',
  tests: [
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
  ],
});
