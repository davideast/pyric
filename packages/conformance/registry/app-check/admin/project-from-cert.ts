import { row } from './section.ts';

export default row({
  order: 110,
  flipped: 'oracle-backed',
  api: 'initializeApp({ credential: cert(serviceAccount) }), then getAppCheck().createToken and verifyToken',
  featureKeys: ['createToken', 'verifyToken'],
  behavior: 'An app initialized with only a cert credential finds its project in the service account\'s `project_id` (or `projectId`), so `createToken` mints a token whose `aud` names `projects/<project_id>` and `verifyToken` accepts it. The `projectId` app option wins over the credential, and the credential wins over `GOOGLE_CLOUD_PROJECT` and `GCLOUD_PROJECT`. The project id is not copied into `app.options`.',
  evidence: 'capture `app-check-admin-project-from-cert` (`snakeCaseCertOverEnv`, `camelCaseCertOverEnv`, `explicitOptionOverCert`, `googleCloudProjectOverGcloudProject`), replayed in `packages/pyric-admin/test/app-check/oracle-conformance.test.ts` and `packages/pyric-admin/test/app-check/project-id.test.ts`.',
  observations: ['app-check-admin-project-from-cert'],
  notes: 'Not claimed: production\'s `cert()` throws on a service account without a private key or client email, or on a file it cannot parse. Pyric\'s `cert()` is inert by design, keeps only the project id, and never throws, so apps run without a key on disk; a credential without a project id falls through to the environment.',
});
