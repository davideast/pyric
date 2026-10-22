/**
 * Production AI pass-through for `firebase/app-check`: the Firebase App Check
 * SDK, attached to the shadow Firebase app whose container `firebase/ai`
 * reads. App Check keys its activation by app object, and the AI SDK looks it
 * up through the shadow app, so `initializeAppCheck` must activate the shadow
 * app, not the Pyric app it is handed. Every other export takes the
 * `AppCheck` instance this returns and passes through unchanged.
 *
 * Served to browser code through `serve/entries/app-ai-passthrough-app-check.ts`
 * and to a registered Node process through the register mapping. The exports
 * are typed loosely on purpose: app code takes its types from `firebase`, and
 * the published declarations of @pyric/cli carry no Firebase SDK edge.
 */
import * as realAppCheck from 'firebase/app-check';
import { shadowAppOf } from './app-bridge-shadow.js';

type RealInitialize = typeof realAppCheck.initializeAppCheck;

export function initializeAppCheck(app: { name: string } | undefined, options: unknown): unknown {
  const shadow = app === undefined ? undefined : shadowAppOf(app);
  return realAppCheck.initializeAppCheck(shadow as Parameters<RealInitialize>[0], options as Parameters<RealInitialize>[1]);
}

export const CustomProvider: unknown = realAppCheck.CustomProvider;
export const ReCaptchaEnterpriseProvider: unknown = realAppCheck.ReCaptchaEnterpriseProvider;
export const ReCaptchaV3Provider: unknown = realAppCheck.ReCaptchaV3Provider;
export const getLimitedUseToken: unknown = realAppCheck.getLimitedUseToken;
export const getToken: unknown = realAppCheck.getToken;
export const onTokenChanged: unknown = realAppCheck.onTokenChanged;
export const setTokenAutoRefreshEnabled: unknown = realAppCheck.setTokenAutoRefreshEnabled;
