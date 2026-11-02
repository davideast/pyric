/**
 * The secret that lets only the host's proxy reach the Functions child's HTTP
 * listener. The host makes a new token for each spawn and passes it in the
 * child's environment; the proxy sends it on every forwarded request, and the
 * child answers 403 without it. A page that rebinds its hostname to
 * 127.0.0.1, or any other local process, can find the child's port but not
 * the token, so it cannot call a function or forge the target header.
 */
import { randomBytes } from 'node:crypto';

/** The request header the proxy carries the token in. */
export const CHILD_TOKEN_HEADER = 'x-pyric-functions-token';

/** The child environment variable the host passes the token in. */
export const CHILD_TOKEN_ENV = 'PYRIC_FUNCTIONS_HTTP_TOKEN';

/** 32 random bytes, new for every spawn. */
export function createChildToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Reads the token the host passed, and removes it from the environment before
 * the user's module loads, so function code that dumps `process.env` does not
 * print it. Undefined when the host passed none.
 */
export function takeChildToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env[CHILD_TOKEN_ENV];
  delete env[CHILD_TOKEN_ENV];
  const isMissing = token === undefined || token.length === 0;
  return isMissing ? undefined : token;
}
