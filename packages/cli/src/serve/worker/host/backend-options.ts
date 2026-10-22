/**
 * The Firebase options that pick backend data on the host.
 *
 * The host reads `projectId` (the rules context and the default Realtime
 * Database instance, `rules.ts`, `rtdb-instances.ts`) and `storageBucket` (the
 * default bucket, `storage.ts`). `databaseURL` picks the RTDB instance a
 * client's default `getDatabase()` reads and writes. Two configs that agree on
 * these three reach the same data under the same rules, so the host serves
 * them as one config.
 *
 * The other keys pick nothing on the host: `apiKey` (the host checks no key),
 * `authDomain` (the domain of the sign-in redirect and popup handler),
 * `appId`, `measurementId` (Analytics), `messagingSenderId` (the FCM sender;
 * host messaging does not read it), and `recaptchaEnterpriseSiteKey` (App
 * Check). A page often carries some of these where a server process does not.
 */
import { firebaseOptionsEqual } from 'pyric/app/internal';

type Options = Record<string, unknown>;

export const BACKEND_OPTION_KEYS = ['projectId', 'databaseURL', 'storageBucket'] as const;

function differingBackendKeys(expected: Options, actual: Options): string[] {
  return BACKEND_OPTION_KEYS.filter((key) => !firebaseOptionsEqual(expected[key], actual[key]));
}

/** Whether two configs reach the same backend data. */
export function sameBackend(expected: Options | undefined, actual: Options | undefined): boolean {
  const isEitherMissing = expected === undefined || actual === undefined;
  if (isEitherMissing) return expected === actual;
  return differingBackendKeys(expected, actual).length === 0;
}

/** ` (differs on: a, b)`, naming the backend keys that differ, or nothing when either side is unknown or none does. */
export function differenceDetail(expected?: Options, actual?: Options): string {
  const differing = expected && actual ? differingBackendKeys(expected, actual) : [];
  const hasDifference = differing.length > 0;
  return hasDifference ? ` (differs on: ${differing.join(', ')})` : '';
}
