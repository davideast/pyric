import { row } from './section.ts';

export default row({
  order: 30,
  diverged: 'by-design',
  api: 'getAppCheck().createToken(unknownAppId)',
  featureKeys: ['createToken'],
  behavior: 'Production: an app id the project does not own rejects with `app-check/unknown-error` and the message `App not registered: <appId>.` Sandbox: it has no list of the project\'s registered apps, so it mints a token for any non-empty app id; an empty app id rejects with `app-check/invalid-argument`.',
  evidence: 'capture `app-check-admin-create-token-unknown-app`; the sandbox side is pinned in the admin suite.',
  observations: ['app-check-admin-create-token-unknown-app'],
  errorText: true,
  notes: 'Divergence, by design: the sandbox does not model Firebase app registrations. A project config that lists app ids would let it refuse unknown ones.',
});
