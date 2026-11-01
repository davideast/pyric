/**
 * Where there is no `document`, upstream's reCAPTCHA `getToken` without a
 * debug token never settles: it waits for a reCAPTCHA widget that cannot load
 * (`@firebase/app-check` 0.11.3 `getToken$1`, line 1143). An app reaches that
 * when a shared `firebase.ts` catches the `initializeAppCheck` throw on a
 * server and asks for a token anyway. The sandbox still mints a token there,
 * and warns once per process that production would not.
 */
import { CustomProvider, hasDocument, type AppCheckProvider } from './providers.js';

export const NEVER_SETTLES_WARNING =
  '[pyric/app-check] The sandbox minted an App Check token for a reCAPTCHA provider where there is no document. In production, getToken never settles here, because reCAPTCHA cannot load without a document. On a server, initialize App Check with a CustomProvider.';

let warned = false;

export function warnIfProductionNeverSettles(provider: AppCheckProvider, debugMode: boolean): void {
  const waitsForRecaptcha = !(provider instanceof CustomProvider) && !debugMode && !hasDocument();
  if (!waitsForRecaptcha || warned) return;
  warned = true;
  console.warn(NEVER_SETTLES_WARNING);
}

/** @internal Lets a test see the first warning again. */
export function resetNeverSettlesWarningForTests(): void {
  warned = false;
}
