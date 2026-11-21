import { row } from './section.ts';

export default row({
  order: 30,
  api: 'encodeCallableData() / decodeCallableData() non-finite double & unknown @type validation',
  behavior: 'Throws ArgumentError on non-finite double values (NaN, +-Infinity) or non-String map keys, and rejects unrecognized @type protobuf wrappers.',
  featureKeys: ['rejects non-finite doubles and non-String map keys'],
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart` (rejects non-finite doubles and non-String map keys; decodes nested containers and rejects unknown @type wrappers).',
  tests: [
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
  ],
});
