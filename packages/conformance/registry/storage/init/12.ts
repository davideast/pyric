import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ['getStorage'],
  behavior:
    "The served `firebase/storage` entry accepts bare `getStorage()`, returning the page's shared sandbox handle, and `getStorage(app)` falls back to `'pyric-default'` when both `options.storageBucket` and `bucketUrl` are omitted",
  status: 'conforms',
  automation: 'sandbox-only',
  conformanceDisposition: 'by-design',
  evidence:
    "The canonical served entry supplies the page sandbox when the app argument is omitted, and `getStorage(app)` binds the `'pyric-default'` sandbox store when neither `options.storageBucket` nor `bucketUrl` is configured (by-design zero-config ergonomic vs production's `storage/no-default-bucket` on `ref(storage)`, pinned in `oracle-getstorage-bucket-url-cases.ts`); the entry-path and bundler suites execute the public package shape.",
  notes:
    "By-design zero-config sandbox ergonomic: when both `options.storageBucket` and `bucketUrl` are omitted, `getStorage(app)` keeps the `'pyric-default'` fallback instead of throwing `storage/no-default-bucket` on `ref(storage)` so zero-config apps and sandboxes work out of the box.",
  conformanceTests: [
    'packages/conformance/entry-path/storage.ts',
    'packages/cli/test/serve/bundler.test.ts',
    'packages/pyric/test/storage/oracle-conformance.test.ts',
  ],
  exceptionReason:
    "Pyric-native served bare getStorage() package-resolution overload and deliberate zero-config 'pyric-default' bucket fallback when both options.storageBucket and bucketUrl are omitted.",
});
