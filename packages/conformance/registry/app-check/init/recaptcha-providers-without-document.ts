import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'oracle-backed',
  api: 'initializeAppCheck(app, { provider: new ReCaptchaV3Provider(siteKey) }) with no `document`, and the same for ReCaptchaEnterpriseProvider',
  featureKeys: ['initializeAppCheck', 'ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
  behavior: 'Where there is no `document`, such as a Node process or a server-rendered module, `initializeAppCheck` with either reCAPTCHA provider throws `ReferenceError: document is not defined` synchronously, with or without `FIREBASE_APPCHECK_DEBUG_TOKEN`. App Check is already set up for the app when it throws: a second call with the same options returns the handle, and one with other options throws `appCheck/already-initialized`.',
  evidence: 'capture `app-check-recaptcha-providers-without-document` (`withoutDebugToken`, `withDebugTokenTrue`), replayed in `packages/pyric/test/app-check/oracle-conformance.test.ts`. Integration: `test/apps/sandbox-app-check`.',
  observations: ['app-check-recaptcha-providers-without-document'],
  errorText: true,
  notes: 'After the throw, upstream `getToken` with no debug token never settles in Node, since it waits for a reCAPTCHA widget that never loads; the sandbox mints a token there, as it does for a page.',
});
