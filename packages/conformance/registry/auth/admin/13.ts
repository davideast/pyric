import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: [
    'Auth.tenantManager',
    'Auth.projectConfigManager',
    'Auth.createProviderConfig',
    'Auth.getProviderConfig',
    'Auth.listProviderConfigs',
    'Auth.updateProviderConfig',
    'Auth.deleteProviderConfig',
  ],
  api: 'auth.tenantManager / projectConfigManager / *ProviderConfig',
  behavior:
    'Identity Platform tenant administration, project configuration, and SAML/OIDC provider config CRUD are not implemented in `pyric-admin/auth` and throw or reject explicitly.',
  status: 'unsupported',
  automation: 'unsupported',
  exceptionReason:
    'Identity Platform tenant and IdP configuration admin managers are not modeled in the local sandbox; calls throw or reject explicitly.',
  conformanceTests: [
    'packages/pyric-admin/test/auth/local-auth.test.ts',
    'packages/pyric-admin/test/auth/remote-auth.test.ts',
  ],
  evidence: 'Explicitly rejected on both arms in `local-auth.test.ts` and `remote-auth.test.ts`.',
});
