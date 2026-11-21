import { row } from './section.ts';

export default row({
  order: 70,
  api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey)',
  featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
  behavior: 'Both reCAPTCHA providers construct from a site key and are accepted by `initializeAppCheck` in a realm with a `document`, such as a page.',
  evidence: 'Upstream `firebase/app-check` 12.19.0 typings and App Check web guide; modular probe staged in `packages/conformance/probes/app-check/app-check-recaptcha-providers-construct.ts` (`sdk-probes`, `pendingRowLink: true`) awaiting main-branch capture before row linkage. The sandbox never loads reCAPTCHA.',
});
