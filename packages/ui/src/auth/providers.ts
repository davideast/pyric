/**
 * Provider-id → human label mapping, mirroring the provider set the
 * Firebase emulator UI recognizes (it maps the same ids to icons; a
 * headless library maps them to text and leaves icons to the consumer
 * via `data-pyric-provider-id`).
 */
export const PROVIDER_LABELS: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  'gc.apple.com': 'Game Center',
  'facebook.com': 'Facebook',
  'github.com': 'GitHub',
  'microsoft.com': 'Microsoft',
  'playgames.google.com': 'Play Games',
  'twitter.com': 'Twitter',
  'yahoo.com': 'Yahoo',
  password: 'Email/Password',
  phone: 'Phone',
  anonymous: 'Anonymous',
  oidc: 'OIDC',
  saml: 'SAML',
};

/** Label for a provider id; falls back to the raw id for custom
 *  `OAuthProvider` ids the map doesn't know. */
export function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}
