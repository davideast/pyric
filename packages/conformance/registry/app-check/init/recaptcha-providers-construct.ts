import { row } from './section.ts';

export default row({
  order: 70,
  flipped: 'oracle-backed',
  api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey)',
  featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
  behavior: 'Both reCAPTCHA providers construct from a site key and are accepted by `initializeAppCheck` in a realm with a `document`, such as a page: the first call returns the `AppCheck` handle, a second call with the same site key and provider class returns the identical handle, and a second call with a different site key or the other reCAPTCHA provider class throws `appCheck/already-initialized`.',
  evidence: 'capture `app-check-recaptcha-providers-construct` (`providerContract`), replayed in `packages/pyric/test/app-check/oracle-conformance.test.ts`. Integration: `test/apps/sandbox-app-check`.',
  observations: ['app-check-recaptcha-providers-construct'],
  errorText: true,
  notes: 'Upstream `initialize()` appends a hidden `div` and a reCAPTCHA `<script>` tag to `document`; the sandbox verifies `document` is defined and mints App Check tokens locally without loading external reCAPTCHA scripts.',
});
