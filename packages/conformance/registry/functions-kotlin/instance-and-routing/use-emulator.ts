import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FirebaseFunctions.useEmulator(host, port) / useFunctionsEmulator(origin)',
  behavior: 'Validates non-empty host and 1..65535 port bounds, brackets IPv6 addresses, and routes callable HTTP requests to http://<host>:<port>/<projectId>/<region>/<name>.',
  featureKeys: ['FirebaseFunctions.useEmulator', 'useFunctionsEmulator'],
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` (getInstance KTX caching customDomain URL rewriting and off-machine refusal).',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
  ],
});
