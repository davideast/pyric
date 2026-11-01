import { expect } from 'bun:test';

/** Long enough for a loopback request, short enough to fail inside a test's timeout. */
const NEXT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Check an answer the server sent before it read the request body to its end,
 * as an early 413 is. It must close the connection (#1706), and the client's
 * next request must be answered. Under `bun test` the server runs inside Bun,
 * whose `node:http` kept the socket open after the close header, so Bun's
 * fetch waited on it and the next request hung (#1710).
 */
export async function expectClosedEarlyAnswer(
  response: Response,
  status: number,
  nextUrl: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('connection')).toBe('close');
  await response.arrayBuffer();
  // Any answer will do: a hang rejects with a TimeoutError.
  const next = await fetch(nextUrl, { signal: AbortSignal.timeout(NEXT_REQUEST_TIMEOUT_MS) });
  await next.arrayBuffer();
}
