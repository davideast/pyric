/**
 * firebase-admin's error shape (`lib/utils/error.js` and `lib/app/error.js`,
 * v14.5.1), shared by the admin mirrors so each service's error class matches
 * upstream in one place.
 *
 * Upstream stores `code` as an own enumerable property on `FirebaseError`
 * (alongside optional `cause` and `httpResponse`), while service subclasses set
 * an own `codePrefix`. `hasCode()` accepts both the prefixed and unprefixed
 * code, and `toJSON()` serializes `code` and `message` (plus `httpResponse` and
 * `cause` when present). Upstream never overrides `name`, so `name` reads
 * `'Error'` while `constructor.name` reflects the subclass.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly data: unknown;
}

export interface ErrorInfo {
  code: string;
  message: string;
  cause?: unknown;
  httpResponse?: HttpResponse;
}

export class FirebaseError extends Error {
  readonly code: string;
  declare readonly cause?: unknown;
  declare readonly httpResponse?: HttpResponse;

  constructor(errorInfo: ErrorInfo) {
    super(errorInfo.message);
    this.code = errorInfo.code;
    if (errorInfo.cause !== undefined) {
      (this as { cause?: unknown }).cause = errorInfo.cause;
    }
    if (errorInfo.httpResponse !== undefined) {
      (this as { httpResponse?: HttpResponse }).httpResponse = errorInfo.httpResponse;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  hasCode(code: string): boolean {
    if (this.code === code) {
      return true;
    }
    const prefix = (this as { readonly codePrefix?: string }).codePrefix;
    return prefix !== undefined && this.code === `${prefix}/${code}`;
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (this.httpResponse !== undefined) {
      json.httpResponse = {
        status: this.httpResponse.status,
        headers: this.httpResponse.headers,
        data: this.httpResponse.data,
      };
    }
    if (this.cause !== undefined) {
      const causeObj = this.cause as {
        readonly name?: unknown;
        readonly message?: unknown;
        readonly stack?: unknown;
        readonly errors?: unknown;
      };
      let causeName = 'Error';
      if (typeof causeObj?.name === 'string' && causeObj.name !== '') {
        causeName = causeObj.name;
      }
      let causeMessage = String(this.cause);
      if (typeof causeObj?.message === 'string' && causeObj.message !== '') {
        causeMessage = causeObj.message;
      }
      const serializedCause: Record<string, unknown> = {
        name: causeName,
        message: causeMessage,
        stack: causeObj?.stack,
      };
      if (
        typeof this.cause === 'object' &&
        this.cause !== null &&
        'errors' in this.cause &&
        Array.isArray(causeObj.errors)
      ) {
        serializedCause.errors = causeObj.errors.map((entry: unknown) => {
          if (entry instanceof Error) {
            return { name: entry.name, message: entry.message, stack: entry.stack };
          }
          return String(entry);
        });
      }
      json.cause = serializedCause;
    }
    return json;
  }
}

export class PrefixedFirebaseError extends FirebaseError {
  readonly codePrefix: string;

  constructor(codePrefix: string, code: string, message: string, extras?: Omit<ErrorInfo, 'code' | 'message'>) {
    const info: ErrorInfo = {
      code: `${codePrefix}/${code}`,
      message,
    };
    if (extras?.httpResponse !== undefined) {
      info.httpResponse = extras.httpResponse;
    }
    if (extras?.cause !== undefined) {
      info.cause = extras.cause;
    }
    super(info);
    this.codePrefix = codePrefix;
  }
}

export const AppErrorCode = {
  APP_DELETED: 'app-deleted',
  DUPLICATE_APP: 'duplicate-app',
  INVALID_ARGUMENT: 'invalid-argument',
  INTERNAL_ERROR: 'internal-error',
  INVALID_APP_NAME: 'invalid-app-name',
  INVALID_APP_OPTIONS: 'invalid-app-options',
  INVALID_CREDENTIAL: 'invalid-credential',
  NETWORK_ERROR: 'network-error',
  NETWORK_TIMEOUT: 'network-timeout',
  NO_APP: 'no-app',
  UNABLE_TO_PARSE_RESPONSE: 'unable-to-parse-response',
} as const;

export type AppErrorCodeValue = (typeof AppErrorCode)[keyof typeof AppErrorCode];

export class FirebaseAppError extends PrefixedFirebaseError {
  constructor(codeOrInfo: string | ErrorInfo, message?: string) {
    if (typeof codeOrInfo === 'string') {
      super('app', codeOrInfo, message ?? '');
      return;
    }
    let resolvedMessage = codeOrInfo.message;
    if (message !== undefined && message !== '') {
      resolvedMessage = message;
    }
    super('app', codeOrInfo.code, resolvedMessage, {
      httpResponse: codeOrInfo.httpResponse,
      cause: codeOrInfo.cause,
    });
  }
}
