/**
 * firebase-admin's error shape (lib/utils/error.js, 13.10.0), shared by the
 * admin mirrors so each service's error class matches upstream in one place.
 *
 * Upstream keeps `{ code, message }` in an own `errorInfo` property and reads
 * `code` through a prototype getter. Its `message` getter is shadowed by the
 * own, non-enumerable `message` that `Error` sets, so only `code` needs one
 * here. `toJSON()` returns both, and
 * `hasCode()` tests the unprefixed code. It never sets `name`, so `name` reads
 * `Error`. The own enumerable keys are `errorInfo` and `codePrefix`.
 */
export interface ErrorInfo {
  code: string;
  message: string;
}

export class FirebaseError extends Error {
  readonly errorInfo: ErrorInfo;

  constructor(errorInfo: ErrorInfo) {
    super(errorInfo.message);
    this.errorInfo = errorInfo;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get code(): string {
    return this.errorInfo?.code;
  }

  toJSON(): ErrorInfo {
    return { code: this.code, message: this.message };
  }
}

export class PrefixedFirebaseError extends FirebaseError {
  readonly codePrefix: string;

  constructor(codePrefix: string, code: string, message: string) {
    super({ code: `${codePrefix}/${code}`, message });
    this.codePrefix = codePrefix;
  }

  hasCode(code: string): boolean {
    return `${this.codePrefix}/${code}` === this.code;
  }
}
