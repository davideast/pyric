import { row } from './section.ts';

export default row({
  order: 70,
  api: 'new ReCaptchaV3Provider(siteKey); new ReCaptchaEnterpriseProvider(siteKey)',
  featureKeys: ['ReCaptchaV3Provider', 'ReCaptchaEnterpriseProvider'],
  behavior: 'Both reCAPTCHA providers construct from a site key and are accepted by `initializeAppCheck` in a realm with a `document`, such as a page.',
  evidence: 'Upstream-documented only (firebase 12.13.0 typings and the App Check web guide). The oracle web app has no reCAPTCHA registration, so no capture exists; the sandbox never loads reCAPTCHA.',
});
