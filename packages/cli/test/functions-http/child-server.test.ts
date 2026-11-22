import { describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  MAX_V1_HTTP_BODY_BYTES,
  MAX_V2_HTTP_BODY_BYTES,
  startHttpChildServer,
} from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';

/** Any file inside the conformance package resolves its firebase-functions, and through it express. */
const ENTRY = join(import.meta.dir, '../../../conformance/package.json');

type Res = { end(body: string): void };

function fn(
  exportName: string,
  handler: (req: unknown, res: Res) => void,
  platform: 'gcfv1' | 'gcfv2' = 'gcfv2',
): DiscoveredOnRequest {
  return {
    exportName,
    regions: ['us-central1'],
    platform,
    privateInvoker: false,
    timeoutSeconds: null,
    handler: handler as DiscoveredOnRequest['handler'],
  };
}

const TOKEN = 'spawn-token';

const call = (port: number, name: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-pyric-function-target': name, [CHILD_TOKEN_HEADER]: TOKEN } });

/** A raw request, so the test can send any Host header, as a rebinding page's browser would. */
function rawCall(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveCall, rejectCall) => {
    const outgoing = request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolveCall({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on('error', rejectCall);
    outgoing.end('{}');
  });
}

describe('the child HTTP server', () => {
  test('close lets an in-flight request finish (a reload must not cut it)', async () => {
    const server = await startHttpChildServer(ENTRY, [
      fn('slow', (_req, res) => { setTimeout(() => res.end('done'), 300); }),
    ], { token: TOKEN });
    const inFlight = call(server.port, 'slow');
    await Bun.sleep(50);
    const closed = server.close();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
    await closed;
  });

  test('close force-closes a request still open after the drain deadline', async () => {
    const server = await startHttpChildServer(ENTRY, [fn('hang', () => undefined)], { token: TOKEN, drainMs: 200 });
    const inFlight = call(server.port, 'hang').then(() => 'answered', () => 'closed');
    await Bun.sleep(50);
    const startedAt = Date.now();
    await server.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await inFlight).toBe('closed');
  });

  test('a request without the spawn token gets 403 and runs nothing, whatever Host and target it names', async () => {
    let ran = 0;
    const server = await startHttpChildServer(ENTRY, [
      fn('pyricHttpPrivate', (_req, res) => { ran += 1; res.end('ran'); }),
    ], { token: TOKEN });
    try {
      const forged = { 'x-pyric-function-target': 'pyricHttpPrivate', 'content-type': 'application/json' };
      const rebound = await rawCall(server.port, { ...forged, host: 'attacker.example' });
      expect(rebound.status).toBe(403);
      const local = await rawCall(server.port, forged);
      expect(local.status).toBe(403);
      const wrong = await rawCall(server.port, { ...forged, host: 'attacker.example', [CHILD_TOKEN_HEADER]: 'guess' });
      expect(wrong.status).toBe(403);
      const tooLong = await rawCall(server.port, { ...forged, [CHILD_TOKEN_HEADER]: `${TOKEN}x` });
      expect(tooLong.status).toBe(403);
      expect(ran).toBe(0);
      const proxied = await rawCall(server.port, { ...forged, [CHILD_TOKEN_HEADER]: TOKEN });
      expect(proxied).toEqual({ status: 200, body: 'ran' });
      expect(ran).toBe(1);
    } finally {
      await server.close();
    }
  });

  test('the function never sees the token or target header, in headers or rawHeaders', async () => {
    type Seen = { headers: Record<string, unknown>; rawHeaders: string[] };
    const server = await startHttpChildServer(ENTRY, [
      fn('headers', (req, res) => {
        const { headers, rawHeaders } = req as Seen;
        res.end(JSON.stringify({ headers, rawHeaders }));
      }),
    ], { token: TOKEN });
    try {
      const response = await call(server.port, 'headers');
      const { headers, rawHeaders } = (await response.json()) as Seen;
      expect(headers[CHILD_TOKEN_HEADER]).toBeUndefined();
      expect(headers['x-pyric-function-target']).toBeUndefined();
      const rawNames = rawHeaders.filter((_, at) => at % 2 === 0).map((name) => name.toLowerCase());
      expect(rawNames).not.toContain(CHILD_TOKEN_HEADER);
      expect(rawNames).not.toContain('x-pyric-function-target');
      expect(rawHeaders).not.toContain(TOKEN);
      expect(rawNames).toContain('host');
    } finally {
      await server.close();
    }
  });

  test('enforces 10 MB uncompressed limit on 1st-gen and 32 MB on 2nd-gen functions across Content-Length, chunked, gzip, and untyped bodies (#1943)', async () => {
    let v1Runs = 0;
    let v2Runs = 0;
    const server = await startHttpChildServer(
      ENTRY,
      [
        fn(
          'v1Upload',
          (req, res) => {
            v1Runs += 1;
            const rawBody = (req as { rawBody?: Buffer }).rawBody;
            res.end(`v1:${rawBody?.byteLength ?? 0}`);
          },
          'gcfv1',
        ),
        fn(
          'v2Upload',
          (req, res) => {
            v2Runs += 1;
            const rawBody = (req as { rawBody?: Buffer }).rawBody;
            res.end(`v2:${rawBody?.byteLength ?? 0}`);
          },
          'gcfv2',
        ),
      ],
      { token: TOKEN },
    );

    const chunkedBody = (totalBytes: number): ReadableStream<Uint8Array> => {
      const unit = new Uint8Array(1024 * 1024);
      let remaining = totalBytes;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining <= 0) {
            controller.close();
            return;
          }
          const count = Math.min(remaining, unit.byteLength);
          remaining -= count;
          if (count === unit.byteLength) {
            controller.enqueue(unit);
          } else {
            controller.enqueue(unit.subarray(0, count));
          }
        },
      });
    };

    const postChunked = async (
      targetName: string,
      totalBytes: number,
      contentType?: string,
    ): Promise<number> => {
      const headers: Record<string, string> = {
        'x-pyric-function-target': targetName,
        [CHILD_TOKEN_HEADER]: TOKEN,
      };
      if (contentType !== undefined) {
        headers['content-type'] = contentType;
      }
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers,
        body: chunkedBody(totalBytes),
        duplex: 'half',
      };
      const response = await fetch(`http://127.0.0.1:${server.port}/`, init);
      return response.status;
    };

    try {
      const exact10Mb = new Uint8Array(MAX_V1_HTTP_BODY_BYTES);
      const okV1 = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pyric-function-target': 'v1Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: exact10Mb,
      });
      expect(okV1.status).toBe(200);
      expect(await okV1.text()).toBe(`v1:${MAX_V1_HTTP_BODY_BYTES}`);
      expect(v1Runs).toBe(1);

      // Exact #1943 repro: 12 MiB POST to v1 is refused with 413; v2 accepts it.
      const twelveMb = new Uint8Array(12 * 1024 * 1024);
      const refusedV1 = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pyric-function-target': 'v1Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: twelveMb,
      });
      expect(refusedV1.status).toBe(413);
      expect(v1Runs).toBe(1);

      // Untyped (missing Content-Type) 12 MiB POST to v1 is also refused with 413.
      const refusedV1Untyped = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'x-pyric-function-target': 'v1Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: twelveMb,
      });
      expect(refusedV1Untyped.status).toBe(413);
      expect(v1Runs).toBe(1);

      // Gzip-compressed body < 50 KB on the wire that expands past 10 MiB uncompressed is refused.
      const compressedOver10Mb = gzipSync(Buffer.alloc(MAX_V1_HTTP_BODY_BYTES + 1024, 0x7a));
      expect(compressedOver10Mb.byteLength).toBeLessThan(100_000);
      const refusedGzipV1 = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-encoding': 'gzip',
          'x-pyric-function-target': 'v1Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: compressedOver10Mb,
      });
      expect(refusedGzipV1.status).toBe(413);
      expect(v1Runs).toBe(1);

      // Chunked Transfer-Encoding (no Content-Length) past 10 MiB on v1 is refused, with and without Content-Type.
      expect(await postChunked('v1Upload', MAX_V1_HTTP_BODY_BYTES + 1, 'application/octet-stream')).toBe(413);
      expect(await postChunked('v1Upload', MAX_V1_HTTP_BODY_BYTES + 1)).toBe(413);
      expect(v1Runs).toBe(1);

      // 2nd-gen accepts 12 MiB and refuses above 32 MiB.
      const okV2 = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pyric-function-target': 'v2Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: twelveMb,
      });
      expect(okV2.status).toBe(200);
      expect(await okV2.text()).toBe(`v2:${twelveMb.byteLength}`);
      expect(v2Runs).toBe(1);

      const over32Mb = new Uint8Array(MAX_V2_HTTP_BODY_BYTES + 1);
      const refusedV2 = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-pyric-function-target': 'v2Upload',
          [CHILD_TOKEN_HEADER]: TOKEN,
        },
        body: over32Mb,
      });
      expect(refusedV2.status).toBe(413);
      expect(v2Runs).toBe(1);
    } finally {
      await server.close();
    }
  }, 30_000);
});
