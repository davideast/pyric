/**
 * The Firebase options that pick backend data on the host.
 *
 * The host reads `projectId` (the rules context and the default Realtime
 * Database instance, `rules.ts`, `rtdb-instances.ts`) and `storageBucket` (the
 * default bucket, `storage.ts`). `databaseURL` picks the RTDB instance a
 * client's default `getDatabase()` reads and writes. Two configs that agree on
 * these three reach the same data under the same rules, so the host serves
 * them as one config. `databaseURL` is compared by the instance it names
 * (case, a trailing slash, `?ns=`, a project's legacy default URL, and an
 * absent URL that leaves the project's default all agree); a bucket with or
 * without `gs://` is one bucket.
 *
 * The other keys pick nothing on the host: `apiKey` (the host checks no key),
 * `authDomain` (the domain of the sign-in redirect and popup handler),
 * `appId`, `measurementId` (Analytics), `messagingSenderId` (the FCM sender;
 * host messaging does not read it), and `recaptchaEnterpriseSiteKey` (App
 * Check). A page often carries some of these where a server process does not.
 */
import { firebaseOptionsEqual } from 'pyric/app/internal';
import {
  defaultDatabaseInstanceName,
  isDefaultDatabaseInstance,
  resolveDatabaseInstance,
} from 'pyric/sandbox/internal';

type Options = Record<string, unknown>;

export const BACKEND_OPTION_KEYS = ['projectId', 'databaseURL', 'storageBucket'] as const;

/** The RTDB instance a config's `getDatabase()` uses: the one `databaseURL` names, else the project's default. */
function databaseInstanceOf(options: Options): unknown {
  const url = options.databaseURL;
  const projectId = typeof options.projectId === 'string' ? options.projectId : undefined;
  const hasUrl = typeof url === 'string' && url.trim().length > 0;
  if (!hasUrl) return projectId === undefined ? url : defaultDatabaseInstanceName(projectId);
  try {
    const name = resolveDatabaseInstance(url)?.name;
    const namesDefault = name !== undefined && isDefaultDatabaseInstance(name, projectId);
    return namesDefault ? defaultDatabaseInstanceName(projectId!) : name;
  } catch {
    return url;
  }
}

/** A bucket as `getStorage()` selects it: `gs://` and a trailing slash name the same bucket. */
function bucketOf(options: Options): unknown {
  const bucket = options.storageBucket;
  if (typeof bucket !== 'string') return bucket;
  return bucket.replace(/^gs:\/\//, '').replace(/\/$/, '');
}

function sameBackendValue(key: typeof BACKEND_OPTION_KEYS[number], expected: Options, actual: Options): boolean {
  if (key === 'databaseURL') return firebaseOptionsEqual(databaseInstanceOf(expected), databaseInstanceOf(actual));
  if (key === 'storageBucket') return firebaseOptionsEqual(bucketOf(expected), bucketOf(actual));
  return firebaseOptionsEqual(expected[key], actual[key]);
}

function differingBackendKeys(expected: Options, actual: Options): string[] {
  return BACKEND_OPTION_KEYS.filter((key) => !sameBackendValue(key, expected, actual));
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
