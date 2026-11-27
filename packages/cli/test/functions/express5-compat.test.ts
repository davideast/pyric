/**
 * Regression tests for Express 5 (`firebase-functions@7.4.0` / `express@5.2.1`)
 * compatibility in `startHttpChildServer`:
 *  - `'query parser'` configured to `'extended'` so nested/bracketed query keys
 *    (`nested[k]=v`, `deep[a][b]=c`) parse identically to Express 4 / Cloud Functions.
 *  - Bodyless requests (`GET`, `HEAD`, `DELETE`, empty `POST`) and untyped requests
 *    normalize `req.body` to `{}` instead of `undefined` without interfering with
 *    JSON, text, urlencoded, raw, or `rawBody` parsing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { startHttpChildServer } from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import type { DiscoveredOnRequest } from '../../src/functions/http/discovery.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const TOKEN = 'express5-compat-token';

const tempDirs = trackTempDirs('pyric-express5-compat-');
let express5Entry = '';

interface EchoPayload {
  method: string;
  query: Record<string, unknown>;
  bodyType: string;
  body: unknown;
  rawBody: string | null;
}

type ChildRes = {
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

function makeFn(
  exportName: string,
  handler: (req: Record<string, unknown>, res: ChildRes) => void,
): DiscoveredOnRequest {
  return {
    exportName,
    regions: ['us-central1'],
    platform: 'gcfv2',
    privateInvoker: false,
    timeoutSeconds: null,
    handler: handler as unknown as DiscoveredOnRequest['handler'],
  };
}

function encodeBody(body: unknown): { bodyType: string; body: unknown } {
  if (Buffer.isBuffer(body)) {
    return { bodyType: 'buffer', body: body.toString('base64') };
  }
  if (body === undefined) {
    return { bodyType: 'undefined', body: null };
  }
  if (body === null) {
    return { bodyType: 'null', body: null };
  }
  return { bodyType: typeof body, body };
}

function rawRequest(
  port: number,
  options: {
    method: string;
    path?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path ?? '/',
        headers: {
          'x-pyric-function-target': 'echo',
          [CHILD_TOKEN_HEADER]: TOKEN,
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolveReq({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    outgoing.on('error', rejectReq);
    if (options.body !== undefined) {
      outgoing.write(options.body);
    }
    outgoing.end();
  });
}

beforeAll(() => {
  // Stage a synthetic functions package whose `firebase-functions` dependency
  // resolves the workspace's real `express@5.2.1` (matching `firebase-functions@7.4.0`).
  const dir = tempDirs.makeTempDir();
  const ffDir = join(dir, 'node_modules/firebase-functions');
  mkdirSync(join(ffDir, 'node_modules'), { recursive: true });
  writeFileSync(
    join(ffDir, 'package.json'),
    JSON.stringify({ name: 'firebase-functions', version: '7.4.0', main: 'index.js' }),
  );
  writeFileSync(join(ffDir, 'index.js'), 'module.exports = {};\n');
  symlinkSync(
    join(REPO_ROOT, 'node_modules/express'),
    join(ffDir, 'node_modules/express'),
  );
  express5Entry = join(dir, 'index.js');
  writeFileSync(express5Entry, 'module.exports = {};\n');
});

afterAll(() => {
  tempDirs.cleanupTempDirs();
});

describe('Express 5 (firebase-functions@7.4.0) HTTP child server compatibility', () => {
  test('parses nested and bracketed query parameters with extended query parser under Express 5', async () => {
    const server = await startHttpChildServer(
      express5Entry,
      [
        makeFn('echo', (req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              method: req.method,
              query: req.query,
              ...encodeBody(req.body),
              rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('base64') : null,
            }),
          );
        }),
      ],
      { token: TOKEN },
    );

    try {
      const res = await rawRequest(server.port, {
        method: 'GET',
        path: '/items?alpha=1&list=a&list=b&nested[k]=v&deep[a][b]=c',
      });
      expect(res.status).toBe(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      const payload = JSON.parse(res.body) as EchoPayload;
      expect(payload).toEqual({
        method: 'GET',
        query: {
          alpha: '1',
          list: ['a', 'b'],
          nested: { k: 'v' },
          deep: { a: { b: 'c' } },
        },
        bodyType: 'object',
        body: {},
        rawBody: null,
      });
    } finally {
      await server.close();
    }
  });

  test('normalizes bodyless GET, HEAD, DELETE, empty POST, and untyped POST req.body to {} under Express 5', async () => {
    const headObserved: Array<{ query: unknown; bodyType: string; body: unknown; rawBody: unknown }> = [];
    const server = await startHttpChildServer(
      express5Entry,
      [
        makeFn('echo', (req, res) => {
          const encoded = encodeBody(req.body);
          if (req.method === 'HEAD') {
            headObserved.push({
              query: req.query,
              bodyType: encoded.bodyType,
              body: encoded.body,
              rawBody: req.rawBody,
            });
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              method: req.method,
              query: req.query,
              ...encoded,
              rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('base64') : null,
            }),
          );
        }),
      ],
      { token: TOKEN },
    );

    try {
      const headRes = await rawRequest(server.port, {
        method: 'HEAD',
        path: '/?nested[flag]=on',
      });
      expect(headRes.status).toBe(200);
      expect(headObserved).toEqual([
        {
          query: { nested: { flag: 'on' } },
          bodyType: 'object',
          body: {},
          rawBody: undefined,
        },
      ]);

      const deleteRes = await rawRequest(server.port, { method: 'DELETE', path: '/resource/1' });
      expect(deleteRes.status).toBe(200);
      expect(JSON.parse(deleteRes.body) as EchoPayload).toEqual({
        method: 'DELETE',
        query: {},
        bodyType: 'object',
        body: {},
        rawBody: null,
      });

      const emptyPost = await rawRequest(server.port, { method: 'POST', path: '/' });
      expect(emptyPost.status).toBe(200);
      expect(JSON.parse(emptyPost.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: {},
        rawBody: null,
      });

      // Missing Content-Type with a raw payload: body-parser skips it, so req.body
      // normalizes to {} while req.rawBody stays unset (matching Express 4).
      const untypedPost = await rawRequest(server.port, {
        method: 'POST',
        path: '/',
        headers: { 'content-length': '5' },
        body: 'pyric',
      });
      expect(untypedPost.status).toBe(200);
      expect(JSON.parse(untypedPost.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: {},
        rawBody: null,
      });
    } finally {
      await server.close();
    }
  });

  test('preserves JSON, CloudEvents JSON, text, urlencoded, raw, rawBody, and 400 malformed JSON under Express 5', async () => {
    let handlerCalls = 0;
    const server = await startHttpChildServer(
      express5Entry,
      [
        makeFn('echo', (req, res) => {
          handlerCalls += 1;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              method: req.method,
              query: req.query,
              ...encodeBody(req.body),
              rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('base64') : null,
            }),
          );
        }),
      ],
      { token: TOKEN },
    );

    try {
      const jsonBody = '{"a":1,"b":[true,null],"c":{"d":"e"}}';
      const jsonRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: jsonBody,
      });
      expect(jsonRes.status).toBe(200);
      expect(JSON.parse(jsonRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: { a: 1, b: [true, null], c: { d: 'e' } },
        rawBody: Buffer.from(jsonBody).toString('base64'),
      });

      const cloudEventBody = '{"specversion":"1.0"}';
      const cloudEventRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/cloudevents+json' },
        body: cloudEventBody,
      });
      expect(cloudEventRes.status).toBe(200);
      expect(JSON.parse(cloudEventRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: { specversion: '1.0' },
        rawBody: Buffer.from(cloudEventBody).toString('base64'),
      });

      const emptyJsonRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '0' },
        body: '',
      });
      expect(emptyJsonRes.status).toBe(200);
      expect(JSON.parse(emptyJsonRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: {},
        rawBody: '',
      });

      const textRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello text',
      });
      expect(textRes.status).toBe(200);
      expect(JSON.parse(textRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'string',
        body: 'hello text',
        rawBody: Buffer.from('hello text').toString('base64'),
      });

      const emptyTextRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'content-length': '0' },
        body: '',
      });
      expect(emptyTextRes.status).toBe(200);
      expect(JSON.parse(emptyTextRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'string',
        body: '',
        rawBody: '',
      });

      const formRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'a[b]=1&c=2&c=3',
      });
      expect(formRes.status).toBe(200);
      expect(JSON.parse(formRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'object',
        body: { a: { b: '1' }, c: ['2', '3'] },
        rawBody: Buffer.from('a[b]=1&c=2&c=3').toString('base64'),
      });

      const binary = Buffer.from([0, 1, 2, 255]);
      const rawRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: binary,
      });
      expect(rawRes.status).toBe(200);
      expect(JSON.parse(rawRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'buffer',
        body: binary.toString('base64'),
        rawBody: binary.toString('base64'),
      });

      const unknownRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/x-pyric-custom' },
        body: 'opaque',
      });
      expect(unknownRes.status).toBe(200);
      expect(JSON.parse(unknownRes.body) as EchoPayload).toEqual({
        method: 'POST',
        query: {},
        bodyType: 'buffer',
        body: Buffer.from('opaque').toString('base64'),
        rawBody: Buffer.from('opaque').toString('base64'),
      });

      const callsBeforeBadJson = handlerCalls;
      const badJsonRes = await rawRequest(server.port, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"truncated":',
      });
      expect(badJsonRes.status).toBe(400);
      expect(handlerCalls).toBe(callsBeforeBadJson);
      expect(badJsonRes.body).not.toContain('node_modules');
    } finally {
      await server.close();
    }
  });
});
