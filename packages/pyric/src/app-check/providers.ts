/**
 * The three attestation providers. The sandbox has no reCAPTCHA, so it never
 * calls a reCAPTCHA provider. It calls a `CustomProvider` as production does
 * when no debug token is set (`state.ts`); under a debug token production
 * never calls one (capture `app-check-client-debug-get-token`,
 * `customProviderCalls: 0`), and neither does the sandbox.
 * `isEqual` decides whether a second `initializeAppCheck` has the same options.
 *
 * `initialize` is called at the end of `initializeAppCheck`, as upstream
 * `_activate` calls each provider's (`@firebase/app-check` 0.11.3, line 1559).
 * Upstream's reCAPTCHA providers add a hidden div to `document` there
 * (`makeDiv`, line 1133), so where there is no `document`, such as a Node
 * process or a server-rendered module, they throw `ReferenceError: document is
 * not defined`, debug token or not. The sandbox throws the same error. A
 * `CustomProvider` needs nothing to initialize.
 */
export interface AppCheckTokenFromProvider {
  readonly token: string;
  readonly expireTimeMillis: number;
}

export interface CustomProviderOptions {
  getToken: () => Promise<AppCheckTokenFromProvider>;
}

interface ComparableProvider {
  initialize(): void;
  isEqual(other: unknown): boolean;
}

/**
 * The error the engine throws when upstream's `makeDiv` reads `document` in a
 * realm without one. V8 and JavaScriptCore word it the same way. It is thrown
 * explicitly rather than by reading `document`, since a bundler may drop a
 * read whose value is unused.
 */
function requireDocument(): void {
  if (!hasDocument()) throw new ReferenceError('document is not defined');
}

export function hasDocument(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== 'undefined';
}

export class ReCaptchaV3Provider implements ComparableProvider {
  constructor(private readonly siteKey: string) {}
  /** @internal */
  initialize(): void {
    requireDocument();
  }
  isEqual(other: unknown): boolean {
    return other instanceof ReCaptchaV3Provider && other.siteKey === this.siteKey;
  }
}

export class ReCaptchaEnterpriseProvider implements ComparableProvider {
  constructor(private readonly siteKey: string) {}
  /** @internal */
  initialize(): void {
    requireDocument();
  }
  isEqual(other: unknown): boolean {
    return other instanceof ReCaptchaEnterpriseProvider && other.siteKey === this.siteKey;
  }
}

export class CustomProvider implements ComparableProvider {
  constructor(private readonly options: CustomProviderOptions) {}
  /** @internal */
  initialize(): void {}
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
