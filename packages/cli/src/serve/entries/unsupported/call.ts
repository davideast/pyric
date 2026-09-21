import { FirebaseError } from 'pyric/app';

/** Missing APIs stay safe to import, reference, and use as an instanceof target. */
export interface UnsupportedServedApi {
  (...args: unknown[]): never;
  new (...args: unknown[]): never;
}

export function unsupportedServedApi(service: string, name: string): UnsupportedServedApi {
  function unavailable(..._args: unknown[]): never {
    throw new FirebaseError(
      `${service}/unsupported-in-served-mode`,
      `${name} is not available in Pyric's served sandbox yet. (${service}/unsupported-in-served-mode)`,
    );
  }
  // A regular function supports both call and construction; both paths throw.
  return unavailable as UnsupportedServedApi;
}
