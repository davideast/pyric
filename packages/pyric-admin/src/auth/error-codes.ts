/**
 * `firebase-admin/auth` client error code catalog (`lib/utils/error.js`, v13.10.0).
 *
 * Each static entry carries the unprefixed `code` and default `message` paired
 * with `FirebaseAuthError` (`auth/<code>`).
 */

export interface AuthErrorCodeInfo {
  readonly code: string;
  readonly message: string;
}

export class AuthClientErrorCode {
  static readonly AUTH_BLOCKING_TOKEN_EXPIRED: AuthErrorCodeInfo = {
    code: 'auth-blocking-token-expired',
    message: 'The provided Firebase Auth Blocking token is expired.',
  };
  static readonly BILLING_NOT_ENABLED: AuthErrorCodeInfo = {
    code: 'billing-not-enabled',
    message: 'Feature requires billing to be enabled.',
  };
  static readonly CLAIMS_TOO_LARGE: AuthErrorCodeInfo = {
    code: 'claims-too-large',
    message: 'Developer claims maximum payload size exceeded.',
  };
  static readonly CONFIGURATION_EXISTS: AuthErrorCodeInfo = {
    code: 'configuration-exists',
    message: 'A configuration already exists with the provided identifier.',
  };
  static readonly CONFIGURATION_NOT_FOUND: AuthErrorCodeInfo = {
    code: 'configuration-not-found',
    message: 'There is no configuration corresponding to the provided identifier.',
  };
  static readonly ID_TOKEN_EXPIRED: AuthErrorCodeInfo = {
    code: 'id-token-expired',
    message: 'The provided Firebase ID token is expired.',
  };
  static readonly INVALID_ARGUMENT: AuthErrorCodeInfo = {
    code: 'argument-error',
    message: 'Invalid argument provided.',
  };
  static readonly INVALID_CONFIG: AuthErrorCodeInfo = {
    code: 'invalid-config',
    message: 'The provided configuration is invalid.',
  };
  static readonly EMAIL_ALREADY_EXISTS: AuthErrorCodeInfo = {
    code: 'email-already-exists',
    message: 'The email address is already in use by another account.',
  };
  static readonly EMAIL_NOT_FOUND: AuthErrorCodeInfo = {
    code: 'email-not-found',
    message: 'There is no user record corresponding to the provided email.',
  };
  static readonly FORBIDDEN_CLAIM: AuthErrorCodeInfo = {
    code: 'reserved-claim',
    message: 'The specified developer claim is reserved and cannot be specified.',
  };
  static readonly INVALID_ID_TOKEN: AuthErrorCodeInfo = {
    code: 'invalid-id-token',
    message: 'The provided ID token is not a valid Firebase ID token.',
  };
  static readonly ID_TOKEN_REVOKED: AuthErrorCodeInfo = {
    code: 'id-token-revoked',
    message: 'The Firebase ID token has been revoked.',
  };
  static readonly INTERNAL_ERROR: AuthErrorCodeInfo = {
    code: 'internal-error',
    message: 'An internal error has occurred.',
  };
  static readonly INVALID_CLAIMS: AuthErrorCodeInfo = {
    code: 'invalid-claims',
    message: 'The provided custom claim attributes are invalid.',
  };
  static readonly INVALID_CONTINUE_URI: AuthErrorCodeInfo = {
    code: 'invalid-continue-uri',
    message: 'The continue URL must be a valid URL string.',
  };
  static readonly INVALID_CREATION_TIME: AuthErrorCodeInfo = {
    code: 'invalid-creation-time',
    message: 'The creation time must be a valid UTC date string.',
  };
  static readonly INVALID_CREDENTIAL: AuthErrorCodeInfo = {
    code: 'invalid-credential',
    message: 'Invalid credential object provided.',
  };
  static readonly INVALID_DISABLED_FIELD: AuthErrorCodeInfo = {
    code: 'invalid-disabled-field',
    message: 'The disabled field must be a boolean.',
  };
  static readonly INVALID_DISPLAY_NAME: AuthErrorCodeInfo = {
    code: 'invalid-display-name',
    message: 'The displayName field must be a valid string.',
  };
  static readonly INVALID_DYNAMIC_LINK_DOMAIN: AuthErrorCodeInfo = {
    code: 'invalid-dynamic-link-domain',
    message:
      'The provided dynamic link domain is not configured or authorized ' +
      'for the current project.',
  };
  static readonly INVALID_HOSTING_LINK_DOMAIN: AuthErrorCodeInfo = {
    code: 'invalid-hosting-link-domain',
    message:
      'The provided hosting link domain is not configured in Firebase ' +
      'Hosting or is not owned by the current project.',
  };
  static readonly INVALID_EMAIL_VERIFIED: AuthErrorCodeInfo = {
    code: 'invalid-email-verified',
    message: 'The emailVerified field must be a boolean.',
  };
  static readonly INVALID_EMAIL: AuthErrorCodeInfo = {
    code: 'invalid-email',
    message: 'The email address is improperly formatted.',
  };
  static readonly INVALID_NEW_EMAIL: AuthErrorCodeInfo = {
    code: 'invalid-new-email',
    message: 'The new email address is improperly formatted.',
  };
  static readonly INVALID_ENROLLED_FACTORS: AuthErrorCodeInfo = {
    code: 'invalid-enrolled-factors',
    message: 'The enrolled factors must be a valid array of MultiFactorInfo objects.',
  };
  static readonly INVALID_ENROLLMENT_TIME: AuthErrorCodeInfo = {
    code: 'invalid-enrollment-time',
    message: 'The second factor enrollment time must be a valid UTC date string.',
  };
  static readonly INVALID_HASH_ALGORITHM: AuthErrorCodeInfo = {
    code: 'invalid-hash-algorithm',
    message:
      'The hash algorithm must match one of the strings in the list of ' +
      'supported algorithms.',
  };
  static readonly INVALID_HASH_BLOCK_SIZE: AuthErrorCodeInfo = {
    code: 'invalid-hash-block-size',
    message: 'The hash block size must be a valid number.',
  };
  static readonly INVALID_HASH_DERIVED_KEY_LENGTH: AuthErrorCodeInfo = {
    code: 'invalid-hash-derived-key-length',
    message: 'The hash derived key length must be a valid number.',
  };
  static readonly INVALID_HASH_KEY: AuthErrorCodeInfo = {
    code: 'invalid-hash-key',
    message: 'The hash key must a valid byte buffer.',
  };
  static readonly INVALID_HASH_MEMORY_COST: AuthErrorCodeInfo = {
    code: 'invalid-hash-memory-cost',
    message: 'The hash memory cost must be a valid number.',
  };
  static readonly INVALID_HASH_PARALLELIZATION: AuthErrorCodeInfo = {
    code: 'invalid-hash-parallelization',
    message: 'The hash parallelization must be a valid number.',
  };
  static readonly INVALID_HASH_ROUNDS: AuthErrorCodeInfo = {
    code: 'invalid-hash-rounds',
    message: 'The hash rounds must be a valid number.',
  };
  static readonly INVALID_HASH_SALT_SEPARATOR: AuthErrorCodeInfo = {
    code: 'invalid-hash-salt-separator',
    message: 'The hashing algorithm salt separator field must be a valid byte buffer.',
  };
  static readonly INVALID_LAST_SIGN_IN_TIME: AuthErrorCodeInfo = {
    code: 'invalid-last-sign-in-time',
    message: 'The last sign-in time must be a valid UTC date string.',
  };
  static readonly INVALID_NAME: AuthErrorCodeInfo = {
    code: 'invalid-name',
    message: 'The resource name provided is invalid.',
  };
  static readonly INVALID_OAUTH_CLIENT_ID: AuthErrorCodeInfo = {
    code: 'invalid-oauth-client-id',
    message: 'The provided OAuth client ID is invalid.',
  };
  static readonly INVALID_PAGE_TOKEN: AuthErrorCodeInfo = {
    code: 'invalid-page-token',
    message: 'The page token must be a valid non-empty string.',
  };
  static readonly INVALID_PASSWORD: AuthErrorCodeInfo = {
    code: 'invalid-password',
    message: 'The password must be a string with at least 6 characters.',
  };
  static readonly INVALID_PASSWORD_HASH: AuthErrorCodeInfo = {
    code: 'invalid-password-hash',
    message: 'The password hash must be a valid byte buffer.',
  };
  static readonly INVALID_PASSWORD_SALT: AuthErrorCodeInfo = {
    code: 'invalid-password-salt',
    message: 'The password salt must be a valid byte buffer.',
  };
  static readonly INVALID_PHONE_NUMBER: AuthErrorCodeInfo = {
    code: 'invalid-phone-number',
    message:
      'The phone number must be a non-empty E.164 standard compliant identifier ' +
      'string.',
  };
  static readonly INVALID_PHOTO_URL: AuthErrorCodeInfo = {
    code: 'invalid-photo-url',
    message: 'The photoURL field must be a valid URL.',
  };
  static readonly INVALID_PROJECT_ID: AuthErrorCodeInfo = {
    code: 'invalid-project-id',
    message:
      "Invalid parent project. Either parent project doesn't exist or didn't enable multi-tenancy.",
  };
  static readonly INVALID_PROVIDER_DATA: AuthErrorCodeInfo = {
    code: 'invalid-provider-data',
    message: 'The providerData must be a valid array of UserInfo objects.',
  };
  static readonly INVALID_PROVIDER_ID: AuthErrorCodeInfo = {
    code: 'invalid-provider-id',
    message: 'The providerId must be a valid supported provider identifier string.',
  };
  static readonly INVALID_PROVIDER_UID: AuthErrorCodeInfo = {
    code: 'invalid-provider-uid',
    message: 'The providerUid must be a valid provider uid string.',
  };
  static readonly INVALID_OAUTH_RESPONSETYPE: AuthErrorCodeInfo = {
    code: 'invalid-oauth-responsetype',
    message: 'Only exactly one OAuth responseType should be set to true.',
  };
  static readonly INVALID_SESSION_COOKIE_DURATION: AuthErrorCodeInfo = {
    code: 'invalid-session-cookie-duration',
    message:
      'The session cookie duration must be a valid number in milliseconds ' +
      'between 5 minutes and 2 weeks.',
  };
  static readonly INVALID_TENANT_ID: AuthErrorCodeInfo = {
    code: 'invalid-tenant-id',
    message: 'The tenant ID must be a valid non-empty string.',
  };
  static readonly INVALID_TENANT_TYPE: AuthErrorCodeInfo = {
    code: 'invalid-tenant-type',
    message: 'Tenant type must be either "full_service" or "lightweight".',
  };
  static readonly INVALID_TESTING_PHONE_NUMBER: AuthErrorCodeInfo = {
    code: 'invalid-testing-phone-number',
    message: 'Invalid testing phone number or invalid test code provided.',
  };
  static readonly INVALID_UID: AuthErrorCodeInfo = {
    code: 'invalid-uid',
    message: 'The uid must be a non-empty string with at most 128 characters.',
  };
  static readonly INVALID_USER_IMPORT: AuthErrorCodeInfo = {
    code: 'invalid-user-import',
    message: 'The user record to import is invalid.',
  };
  static readonly INVALID_TOKENS_VALID_AFTER_TIME: AuthErrorCodeInfo = {
    code: 'invalid-tokens-valid-after-time',
    message: 'The tokensValidAfterTime must be a valid UTC number in seconds.',
  };
  static readonly MISMATCHING_TENANT_ID: AuthErrorCodeInfo = {
    code: 'mismatching-tenant-id',
    message: 'User tenant ID does not match with the current TenantAwareAuth tenant ID.',
  };
  static readonly MISSING_ANDROID_PACKAGE_NAME: AuthErrorCodeInfo = {
    code: 'missing-android-pkg-name',
    message:
      'An Android Package Name must be provided if the Android App is ' +
      'required to be installed.',
  };
  static readonly MISSING_CONFIG: AuthErrorCodeInfo = {
    code: 'missing-config',
    message: 'The provided configuration is missing required attributes.',
  };
  static readonly MISSING_CONTINUE_URI: AuthErrorCodeInfo = {
    code: 'missing-continue-uri',
    message: 'A valid continue URL must be provided in the request.',
  };
  static readonly MISSING_DISPLAY_NAME: AuthErrorCodeInfo = {
    code: 'missing-display-name',
    message: 'The resource being created or edited is missing a valid display name.',
  };
  static readonly MISSING_EMAIL: AuthErrorCodeInfo = {
    code: 'missing-email',
    message:
      'The email is required for the specified action. For example, a multi-factor user ' +
      'requires a verified email.',
  };
  static readonly MISSING_IOS_BUNDLE_ID: AuthErrorCodeInfo = {
    code: 'missing-ios-bundle-id',
    message: 'The request is missing an iOS Bundle ID.',
  };
  static readonly MISSING_ISSUER: AuthErrorCodeInfo = {
    code: 'missing-issuer',
    message: 'The OAuth/OIDC configuration issuer must not be empty.',
  };
  static readonly MISSING_HASH_ALGORITHM: AuthErrorCodeInfo = {
    code: 'missing-hash-algorithm',
    message:
      'Importing users with password hashes requires that the hashing ' +
      'algorithm and its parameters be provided.',
  };
  static readonly MISSING_OAUTH_CLIENT_ID: AuthErrorCodeInfo = {
    code: 'missing-oauth-client-id',
    message: 'The OAuth/OIDC configuration client ID must not be empty.',
  };
  static readonly MISSING_OAUTH_CLIENT_SECRET: AuthErrorCodeInfo = {
    code: 'missing-oauth-client-secret',
    message: 'The OAuth configuration client secret is required to enable OIDC code flow.',
  };
  static readonly MISSING_PROVIDER_ID: AuthErrorCodeInfo = {
    code: 'missing-provider-id',
    message: 'A valid provider ID must be provided in the request.',
  };
  static readonly MISSING_SAML_RELYING_PARTY_CONFIG: AuthErrorCodeInfo = {
    code: 'missing-saml-relying-party-config',
    message: 'The SAML configuration provided is missing a relying party configuration.',
  };
  static readonly MAXIMUM_TEST_PHONE_NUMBER_EXCEEDED: AuthErrorCodeInfo = {
    code: 'test-phone-number-limit-exceeded',
    message: 'The maximum allowed number of test phone number / code pairs has been exceeded.',
  };
  static readonly MAXIMUM_USER_COUNT_EXCEEDED: AuthErrorCodeInfo = {
    code: 'maximum-user-count-exceeded',
    message: 'The maximum allowed number of users to import has been exceeded.',
  };
  static readonly MISSING_UID: AuthErrorCodeInfo = {
    code: 'missing-uid',
    message: 'A uid identifier is required for the current operation.',
  };
  static readonly OPERATION_NOT_ALLOWED: AuthErrorCodeInfo = {
    code: 'operation-not-allowed',
    message:
      'The given sign-in provider is disabled for this Firebase project. ' +
      'Enable it in the Firebase console, under the sign-in method tab of the ' +
      'Auth section.',
  };
  static readonly PHONE_NUMBER_ALREADY_EXISTS: AuthErrorCodeInfo = {
    code: 'phone-number-already-exists',
    message: 'The user with the provided phone number already exists.',
  };
  static readonly PROJECT_NOT_FOUND: AuthErrorCodeInfo = {
    code: 'project-not-found',
    message: 'No Firebase project was found for the provided credential.',
  };
  static readonly INSUFFICIENT_PERMISSION: AuthErrorCodeInfo = {
    code: 'insufficient-permission',
    message:
      'Credential implementation provided to initializeApp() via the "credential" property ' +
      'has insufficient permission to access the requested resource. See ' +
      'https://firebase.google.com/docs/admin/setup for details on how to authenticate this SDK ' +
      'with appropriate permissions.',
  };
  static readonly QUOTA_EXCEEDED: AuthErrorCodeInfo = {
    code: 'quota-exceeded',
    message: 'The project quota for the specified operation has been exceeded.',
  };
  static readonly SECOND_FACTOR_LIMIT_EXCEEDED: AuthErrorCodeInfo = {
    code: 'second-factor-limit-exceeded',
    message: 'The maximum number of allowed second factors on a user has been exceeded.',
  };
  static readonly SECOND_FACTOR_UID_ALREADY_EXISTS: AuthErrorCodeInfo = {
    code: 'second-factor-uid-already-exists',
    message: 'The specified second factor "uid" already exists.',
  };
  static readonly SESSION_COOKIE_EXPIRED: AuthErrorCodeInfo = {
    code: 'session-cookie-expired',
    message: 'The Firebase session cookie is expired.',
  };
  static readonly SESSION_COOKIE_REVOKED: AuthErrorCodeInfo = {
    code: 'session-cookie-revoked',
    message: 'The Firebase session cookie has been revoked.',
  };
  static readonly TENANT_NOT_FOUND: AuthErrorCodeInfo = {
    code: 'tenant-not-found',
    message: 'There is no tenant corresponding to the provided identifier.',
  };
  static readonly UID_ALREADY_EXISTS: AuthErrorCodeInfo = {
    code: 'uid-already-exists',
    message: 'The user with the provided uid already exists.',
  };
  static readonly UNAUTHORIZED_DOMAIN: AuthErrorCodeInfo = {
    code: 'unauthorized-continue-uri',
    message:
      'The domain of the continue URL is not whitelisted. Whitelist the domain in the ' +
      'Firebase console.',
  };
  static readonly UNSUPPORTED_FIRST_FACTOR: AuthErrorCodeInfo = {
    code: 'unsupported-first-factor',
    message: 'A multi-factor user requires a supported first factor.',
  };
  static readonly UNSUPPORTED_SECOND_FACTOR: AuthErrorCodeInfo = {
    code: 'unsupported-second-factor',
    message: 'The request specified an unsupported type of second factor.',
  };
  static readonly UNSUPPORTED_TENANT_OPERATION: AuthErrorCodeInfo = {
    code: 'unsupported-tenant-operation',
    message: 'This operation is not supported in a multi-tenant context.',
  };
  static readonly UNVERIFIED_EMAIL: AuthErrorCodeInfo = {
    code: 'unverified-email',
    message:
      'A verified email is required for the specified action. For example, a multi-factor user ' +
      'requires a verified email.',
  };
  static readonly USER_NOT_FOUND: AuthErrorCodeInfo = {
    code: 'user-not-found',
    message: 'There is no user record corresponding to the provided identifier.',
  };
  static readonly NOT_FOUND: AuthErrorCodeInfo = {
    code: 'not-found',
    message: 'The requested resource was not found.',
  };
  static readonly USER_DISABLED: AuthErrorCodeInfo = {
    code: 'user-disabled',
    message: 'The user record is disabled.',
  };
  static readonly USER_NOT_DISABLED: AuthErrorCodeInfo = {
    code: 'user-not-disabled',
    message: 'The user must be disabled in order to bulk delete it (or you must pass force=true).',
  };
  static readonly INVALID_RECAPTCHA_ACTION: AuthErrorCodeInfo = {
    code: 'invalid-recaptcha-action',
    message: 'reCAPTCHA action must be "BLOCK".',
  };
  static readonly INVALID_RECAPTCHA_ENFORCEMENT_STATE: AuthErrorCodeInfo = {
    code: 'invalid-recaptcha-enforcement-state',
    message: 'reCAPTCHA enforcement state must be either "OFF", "AUDIT" or "ENFORCE".',
  };
  static readonly RECAPTCHA_NOT_ENABLED: AuthErrorCodeInfo = {
    code: 'racaptcha-not-enabled',
    message: 'reCAPTCHA enterprise is not enabled.',
  };
}
