/**
 * Per-app App Check activation, shared by the service mirrors that read it.
 *
 * `pyric/app-check` records an activation when `initializeAppCheck` runs, and
 * `pyric/ai` reads it when `getAI(app)` builds a handle, as the Firebase SDK's
 * AI service reads the App Check provider it was constructed with. Keeping the
 * one lookup here means the served `firebase/app-check` and `firebase/ai`
 * bundles share it through the bundler's shared chunk, and a Node process
 * shares it through the one installed module.
 *
 * Keyed by the app object, as upstream keys App Check.
 */

/** One app's activation: the state its mirror keeps, and the two token reads AI needs. */
export interface AppCheckActivation<State = unknown> {
  readonly state: State;
  /** The app's cached token, minted when missing or expired, as `getToken(appCheck)` returns it. */
  token(): Promise<string>;
  /** A fresh limited-use token, as `getLimitedUseToken(appCheck)` returns it. */
  limitedUseToken(): Promise<string>;
}

const activations = new WeakMap<object, AppCheckActivation>();

export function recordAppCheckActivation<State>(app: object, activation: AppCheckActivation<State>): void {
  activations.set(app, activation);
}

/** The app's activation, or `undefined` when it never called `initializeAppCheck`. */
export function appCheckActivationOf<State = unknown>(app: object): AppCheckActivation<State> | undefined {
  return activations.get(app) as AppCheckActivation<State> | undefined;
}

export interface AppCheckTokenOptions {
  /** Take a fresh limited-use token instead of the cached one (`useLimitedUseAppCheckTokens`). */
  limitedUse?: boolean;
}

/**
 * The mirror token a request from this app carries, or `null` when the app
 * never called `initializeAppCheck`.
 */
export async function appCheckTokenFor(app: object, options: AppCheckTokenOptions = {}): Promise<string | null> {
  const activation = appCheckActivationOf(app);
  if (activation === undefined) return null;
  return options.limitedUse === true ? activation.limitedUseToken() : activation.token();
}
