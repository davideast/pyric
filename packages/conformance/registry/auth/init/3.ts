import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Without sandbox package swapping, canonical `firebase/auth` imports remain Firebase and never enter this mirror",
  status: "conforms",
  evidence: "`oracle:auth-canonical-import-and-createuser-shape` (fb-js-sdk 12.19.0 against the oracle project: unswapped `firebase/auth` resolves to upstream Firebase Auth with `apiHost: 'identitytoolkit.googleapis.com'`, `authNameMatchesAppName: true`, and zero `sandbox` / `mockSignInResult` / `takeAuthMail` properties on the module or `Auth` handle); direct mirror rejection of canonical `firebase/app` handles locked across in-page and served worker planes by `unit:package-resolution.test.ts` and `unit:auth-canonical-import-createuser.test.ts`",
  risk: ["structural", "specific-field"],
  riskScore: 1,
  riskReasons: ["structural / routing-only claim", "asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-canonical-import-and-createuser-shape"],
  conformanceTests: [
    "packages/pyric/test/auth/package-resolution.test.ts",
    "packages/pyric/test/auth/oracle-captures/auth-canonical-import-createuser.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-canonical-import-createuser.test.ts",
  ],
  conformanceChecks: [
    {
      finding: "AUTH-3",
      observation: "auth-canonical-import-and-createuser-shape",
      expect: {
        canonicalImportBoundary: {
          getAuthIsFunction: true,
          hasSandboxNamespaceOnModule: false,
          hasMockSignInResultOnModule: false,
          hasTakeAuthMailOnModule: false,
          hasSandboxPropertyOnAuth: false,
          apiHost: "identitytoolkit.googleapis.com",
          authNameMatchesAppName: true,
        },
      },
      probe: "packages/pyric/test/auth/oracle-captures/auth-canonical-import-createuser.test.ts",
      guards: "Unswapped canonical firebase/auth imports remain upstream Firebase Auth without sandbox helpers and reject entering the pyric/auth mirror.",
    },
  ],
});
