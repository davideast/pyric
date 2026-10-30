/**
 * The three attestation providers. The sandbox has no reCAPTCHA, so it never
 * calls a reCAPTCHA provider. It calls a `CustomProvider` as production does
 * when no debug token is set (`state.ts`); under a debug token production
 * never calls one (capture `app-check-client-debug-get-token`,
 * `customProviderCalls: 0`), and neither does the sandbox.
 * `isEqual` decides whether a second `initializeAppCheck` has the same options.
 */
export interface AppCheckTokenFromProvider {
  readonly token: string;
  readonly expireTimeMillis: number;
}

export interface CustomProviderOptions {
  getToken: () => Promise<AppCheckTokenFromProvider>;
}

interface ComparableProvider {
  isEqual(other: unknown): boolean;
}

export class ReCaptchaV3Provider implements ComparableProvider {
  constructor(private readonly siteKey: string) {}
  isEqual(other: unknown): boolean {
    return other instanceof ReCaptchaV3Provider && other.siteKey === this.siteKey;
  }
}

export class ReCaptchaEnterpriseProvider implements ComparableProvider {
  constructor(private readonly siteKey: string) {}
  isEqual(other: unknown): boolean {
    return other instanceof ReCaptchaEnterpriseProvider && other.siteKey === this.siteKey;
  }
}

export class CustomProvider implements ComparableProvider {
  constructor(private readonly options: CustomProviderOptions) {}
  /** @internal The app's own `getToken`, called as upstream `CustomProvider.getToken` calls it; a rejection propagates. */
  getToken(): Promise<AppCheckTokenFromProvider> {
    return this.options.getToken();
  }
  /** Upstream compares the getToken functions by source text, so a provider rebuilt by the same factory is equal. */
  isEqual(other: unknown): boolean {
    return other instanceof CustomProvider && String(other.options.getToken) === String(this.options.getToken);
  }
}

export type AppCheckProvider = ReCaptchaV3Provider | ReCaptchaEnterpriseProvider | CustomProvider;

export function sameProvider(a: AppCheckProvider, b: AppCheckProvider): boolean {
  return a.isEqual(b);
}
