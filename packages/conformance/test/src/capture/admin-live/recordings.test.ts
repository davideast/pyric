/**
 * Capture A (Admin)'s production recording (issue #2304, step C-1): every case
 * in the run spec got its answer, the Firestore errors carry production's gRPC
 * status and details, the Auth and Storage error bodies and the cert
 * response's header names are recorded, and no credential pattern survived
 * redaction. A credential check reports only a match's length, never the match.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSpec, type Clients } from '../../../../src/capture/admin-live/capture-admin-wire.ts';
import type { GrpcExchange, HttpExchange, RtdbMessage } from '../../../../src/capture/admin-live/live-capture.ts';
import { CREDENTIAL_PATTERNS } from '../../../../src/capture/rtdb-live/live-capture.ts';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/capture/admin-live/recordings/capture-admin-wire.json');

interface Recording {
  name: string;
  adminVersion: string;
  runPath: string;
  results: Record<string, string>;
  invariants: Record<string, boolean>;
  grpc: GrpcExchange[];
  http: HttpExchange[];
  rtdb: RtdbMessage[];
}

const text = readFileSync(FILE, 'utf8');
const recording = JSON.parse(text) as Recording;

/** The run spec's cases and expected answers, read from the capture script itself. Building the steps runs nothing. */
const SPEC = runSpec({} as Clients, { runPath: '', closers: [], onSecret: () => {} } as unknown as Parameters<typeof runSpec>[1])
  .map(({ op, expect }) => ({ op, expect }));

/** The client sign-in is not an Admin call, so the capture pauses its recorders for it. */
const UNRECORDED = new Set(['auth.clientSignIn']);
/** firebase-admin answers this case itself, from the certs an earlier case fetched. */
const LOCAL = new Set(['auth.verifyIdToken-sandbox-token']);

function wireOps(): Set<string> {
  return new Set([...recording.grpc.map((g) => g.op), ...recording.http.map((h) => h.op), ...recording.rtdb.map((m) => m.op)]);
}

function httpFor(op: string, pathEnd: string): HttpExchange {
  const found = recording.http.find((h) => h.op === op && h.path.endsWith(pathEnd));
  if (!found) throw new Error(`no ${pathEnd} exchange for ${op}`);
  return found;
}

function grpcFor(op: string): GrpcExchange {
  const found = recording.grpc.find((g) => g.op === op && g.status !== null && g.status.code !== 0);
  if (!found) throw new Error(`no failed gRPC exchange for ${op}`);
  return found;
}

function lookedUpUser(op: string): Record<string, unknown> | undefined {
  const body = httpFor(op, 'accounts:lookup').response.body;
  if (body?.kind !== 'json') return undefined;
  return (body.json as { users?: Array<Record<string, unknown>> }).users?.[0];
}

describe('capture A (Admin): the production recording', () => {
  test('names the run and read back clean', () => {
    expect(recording.name).toBe('admin-live-capture-admin-wire');
    expect(recording.adminVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(recording.runPath).toBe('pyric_oracle/<run>');
    expect(Object.values(recording.invariants).every(Boolean)).toBe(true);
  });

  test('has the spec loaded from the capture script', () => {
    expect(SPEC.length).toBeGreaterThan(40);
  });

  test.each(SPEC.map((step) => [step.op, step.expect] as const))('%s answered %s', (op, expected) => {
    expect({ op, result: recording.results[op] }).toEqual({ op, result: expected });
  });

  test.each(SPEC.map((step) => step.op).filter((op) => !UNRECORDED.has(op) && !LOCAL.has(op)))('%s has a recorded exchange', (op) => {
    expect({ op, recorded: wireOps().has(op) }).toEqual({ op, recorded: true });
  });

  test('records no exchange for a case outside the spec', () => {
    const ops = new Set(SPEC.map((step) => step.op));
    expect([...wireOps()].filter((op) => !ops.has(op))).toEqual([]);
  });

  test('update on a missing document is gRPC 5 with production details', () => {
    const exchange = grpcFor('firestore.update-missing');
    expect(exchange.method).toBe('google.firestore.v1.Firestore/Commit');
    expect(exchange.status?.code).toBe(5);
    expect(exchange.status?.details).toBe('No document to update: projects/<project>/databases/(default)/documents/pyric_oracle/<run>/notes/missing');
  });

  test('create on an existing document is gRPC 6 with production details', () => {
    const exchange = grpcFor('firestore.create-existing');
    expect(exchange.method).toBe('google.firestore.v1.Firestore/Commit');
    expect(exchange.status?.code).toBe(6);
    expect(exchange.status?.details).toBe('Document already exists: projects/<project>/databases/(default)/documents/pyric_oracle/<run>/notes/a');
  });

  test('auth/user-not-found: the lookup of the deleted user answers with no users', () => {
    const exchange = httpFor('auth.getUser-deleted', 'accounts:lookup');
    expect(exchange.response.status).toBe(200);
    expect(exchange.response.body).toEqual({ kind: 'json', json: { kind: 'identitytoolkit#GetAccountInfoResponse' } });
  });

  test('auth/id-token-revoked: the lookup answers a validSince newer than the one before the revoke', () => {
    const before = lookedUpUser('auth.verifyIdToken-checkRevoked');
    const after = lookedUpUser('auth.verifyIdToken-revoked');
    expect(httpFor('auth.verifyIdToken-revoked', 'accounts:lookup').response.status).toBe(200);
    expect(before?.localId).toBe('<uid-1>');
    expect(after?.localId).toBe('<uid-1>');
    expect(typeof after?.validSince).toBe('string');
    expect(after?.validSince).not.toBe(before?.validSince);
    const revoke = httpFor('auth.revokeRefreshTokens', 'accounts:update').request.body;
    expect(revoke?.kind === 'json' ? Object.keys(revoke.json as object).sort() : null).toEqual(['localId', 'validSince']);
  });

  test('Storage 404: the missing object answers production text body', () => {
    const exchange = httpFor('storage.download-missing', '%2Fmissing.txt');
    expect(exchange.service).toBe('storage');
    expect(exchange.response.status).toBe(404);
    expect(exchange.response.body).toEqual({ kind: 'text', text: 'No such object: <bucket>/pyric_oracle/<run>/missing.txt' });
  });

  test('the cert response keeps its header names and no key body', () => {
    const certs = recording.http.filter((h) => h.service === 'certs');
    expect(certs).toHaveLength(1);
    const exchange = certs[0]!;
    expect(exchange.path).toBe('/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    expect(exchange.response.status).toBe(200);
    expect(exchange.response.headerNames).toEqual(expect.arrayContaining(['cache-control', 'content-type', 'date', 'expires']));
    expect(exchange.response.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(exchange.response.body?.kind).toBe('certs');
  });

  test.each(CREDENTIAL_PATTERNS.map(([label, pattern]) => [label, pattern] as const))('no %s remains', (label, pattern) => {
    const lengths = [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match[0].length);
    expect({ label, present: lengths.length > 0, lengths }).toEqual({ label, present: false, lengths: [] });
  });
});
