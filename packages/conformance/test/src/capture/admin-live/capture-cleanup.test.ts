/**
 * Capture A (Admin)'s cleanup removes the run's user, every document under the
 * run path, the RTDB run path and every object under the run prefix, whatever
 * failed before it, reads each back, and reports a failure as an invariant,
 * not a throw. The recorders drop the RTDB credential frame and keep gRPC
 * statuses. Production is a fake; nothing reaches the network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  announceRunId,
  cleanupAdminRun,
  GrpcRecorder,
  newStamp,
  Placeholders,
  RtdbRecorder,
  runPathFor,
  runWithAdminCleanup,
  userEmailFor,
  type AdminRunState,
} from '../../../../src/capture/admin-live/live-capture.ts';
import { Redactor } from '../../../../src/capture/rtdb-live/live-capture.ts';

const RUN = { runId: '1762400000000-abc123' };
const RUN_PATH = runPathFor(RUN.runId);
const OTHER = 'pyric_oracle/other-run';

interface FakeProject {
  state: AdminRunState;
  users: Map<string, string>;
  documents: Set<string>;
  rtdb: Map<string, unknown>;
  objects: Set<string>;
  calls: string[];
}

/** A fake project: users by email, document paths, RTDB values by path, object names. `fail` names one delete that rejects. */
function fakeProject(fail: string | null = null): FakeProject {
  const users = new Map<string, string>();
  const documents = new Set<string>();
  const rtdb = new Map<string, unknown>();
  const objects = new Set<string>();
  const calls: string[] = [];
  const failing = (name: string) => {
    calls.push(name);
    if (name === fail) throw new Error('UNAVAILABLE');
  };
  const state: AdminRunState = {
    users: {
      async find(email) { return users.get(email) ?? null; },
      async remove(uid) {
        failing(`remove user ${uid}`);
        for (const [email, id] of users) if (id === uid) users.delete(email);
      },
    },
    documents: {
      async list(runPath) { return [...documents].filter((path) => path.startsWith(`${runPath}/`)); },
      async remove(path) { failing(`remove document ${path}`); documents.delete(path); },
    },
    rtdb: {
      async read(path) { return rtdb.get(path) ?? null; },
      async remove(path) { failing(`remove rtdb ${path}`); rtdb.delete(path); },
    },
    objects: {
      async list(prefix) { return [...objects].filter((name) => name.startsWith(prefix)); },
      async remove(name) { failing(`remove object ${name}`); objects.delete(name); },
    },
  };
  return { state, users, documents, rtdb, objects, calls };
}

/** What a sequence that stopped halfway leaves behind, plus another run's state that must survive. */
function leaveHalfARun(project: FakeProject): void {
  project.users.set(userEmailFor(RUN.runId), 'uid-1');
  project.documents.add(`${RUN_PATH}/notes/a`);
  project.documents.add(`${RUN_PATH}/notes/b`);
  project.rtdb.set(RUN_PATH, { a: 1 });
  project.objects.add(`${RUN_PATH}/note.txt`);
  project.users.set('someone@example.com', 'uid-kept');
  project.documents.add(`${OTHER}/notes/kept`);
  project.rtdb.set(OTHER, { kept: true });
  project.objects.add(`${OTHER}/kept.txt`);
}

const HELD = { userDeleted: true, documentsRemoved: true, rtdbRemoved: true, objectsRemoved: true };

function expectOnlyOtherRunLeft(project: FakeProject): void {
  expect([...project.users.values()]).toEqual(['uid-kept']);
  expect([...project.documents]).toEqual([`${OTHER}/notes/kept`]);
  expect([...project.rtdb.keys()]).toEqual([OTHER]);
  expect([...project.objects]).toEqual([`${OTHER}/kept.txt`]);
}

describe('runWithAdminCleanup', () => {
  test('removes the user, documents, RTDB path and objects the sequence created, and reads each back', async () => {
    const project = fakeProject();
    const run = await runWithAdminCleanup('fake', project.state, RUN, async () => {
      leaveHalfARun(project);
      return 'done';
    });
    expect(run.result).toBe('done');
    expect(run.invariants).toEqual(HELD);
    expect(run.failures).toEqual([]);
    expectOnlyOtherRunLeft(project);
  });

  test('refuses a run that already holds anything, before the sequence runs', async () => {
    const project = fakeProject();
    project.rtdb.set(RUN_PATH, { stale: true });
    let ran = false;
    await expect(runWithAdminCleanup('fake', project.state, RUN, async () => { ran = true; })).rejects.toThrow(/already holds RTDB data/);
    expect(ran).toBe(false);
    expect(project.rtdb.get(RUN_PATH)).toEqual({ stale: true });
  });

  test('keeps the sequence error and still cleans up when the sequence throws', async () => {
    const project = fakeProject();
    const run = await runWithAdminCleanup('fake', project.state, RUN, async () => {
      leaveHalfARun(project);
      throw new Error('sequence failed');
    });
    expect(run.error?.message).toBe('sequence failed');
    expect(run.invariants).toEqual(HELD);
    expectOnlyOtherRunLeft(project);
  });

  test('a failed delete is an invariant failure, and every other step still runs', async () => {
    const project = fakeProject(`remove document ${RUN_PATH}/notes/a`);
    const run = await runWithAdminCleanup('fake', project.state, RUN, async () => leaveHalfARun(project));
    expect(run.invariants).toEqual({ ...HELD, documentsRemoved: false });
    expect(run.failures).toEqual([`remove document ${RUN_PATH}/notes/a: UNAVAILABLE`]);
    expect([...project.documents]).toEqual([`${RUN_PATH}/notes/a`, `${OTHER}/notes/kept`]);
    expect(project.rtdb.has(RUN_PATH)).toBe(false);
    expect(project.objects.has(`${RUN_PATH}/note.txt`)).toBe(false);
    expect(project.users.has(userEmailFor(RUN.runId))).toBe(false);
  });

  test('a failed user delete leaves the user found, and the invariant says so', async () => {
    const project = fakeProject('remove user uid-1');
    const run = await runWithAdminCleanup('fake', project.state, RUN, async () => leaveHalfARun(project));
    expect(run.invariants).toEqual({ ...HELD, userDeleted: false });
    expect(project.documents.has(`${RUN_PATH}/notes/b`)).toBe(false);
  });

  test('stops what is still running before it reads any state', async () => {
    const project = fakeProject();
    const order: string[] = [];
    await runWithAdminCleanup('fake', project.state, RUN, async () => leaveHalfARun(project), {
      quiesce: async () => { order.push(`quiesce after ${project.calls.length} deletes`); },
    });
    expect(order).toEqual(['quiesce after 0 deletes']);
    expect(project.calls[0]).toBe('remove user uid-1');
  });
});

describe('cleanupAdminRun, the --cleanup path', () => {
  test('cleans a run that stopped partway, from its run id alone', async () => {
    const project = fakeProject();
    leaveHalfARun(project);
    const { invariants, failures } = await cleanupAdminRun('fake', project.state, RUN);
    expect(invariants).toEqual(HELD);
    expect(failures).toEqual([]);
    expectOnlyOtherRunLeft(project);
  });

  test('a run that left nothing reads back clean', async () => {
    const project = fakeProject();
    const { invariants } = await cleanupAdminRun('fake', project.state, RUN);
    expect(invariants).toEqual(HELD);
    expect(project.calls).toEqual([`remove rtdb ${RUN_PATH}`]);
  });
});

describe('announceRunId', () => {
  test('prints the cleanup command and appends it to the run-id file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'capture-admin-')), 'run-ids.log');
    const printed: string[] = [];
    announceRunId(RUN.runId, { write: (line) => printed.push(line), file });
    expect(printed).toEqual([`[capture-admin] run ${RUN.runId}; if it stops partway, run the cleanup with --cleanup ${RUN.runId}`]);
    expect(readFileSync(file, 'utf8')).toContain(`--cleanup ${RUN.runId}`);
  });
});

describe('recorders', () => {
  test('the RTDB recorder drops the gauth body and its answer, and keeps the data messages', () => {
    class FakeConnection {
      realtime_ = null;
      requestNumber_ = 0;
      sendRequest(_action: string, _body: unknown): void { this.requestNumber_ += 1; }
      onDataMessage_(_message: Record<string, unknown>): void {}
    }
    const connection = new FakeConnection();
    const recorder = new RtdbRecorder(newStamp());
    const uninstall = recorder.install(connection);
    connection.sendRequest('gauth', { cred: 'ya29.secret-access-token' });
    connection.onDataMessage_({ r: 1, b: { s: 'ok', d: { auth: { provider: 'service-account' } } } });
    connection.sendRequest('p', { p: `/${RUN_PATH}`, d: { a: 1 } });
    connection.onDataMessage_({ r: 2, b: { s: 'ok', d: '' } });
    uninstall();
    expect(recorder.messages.map(({ dir, message }) => ({ dir, message }))).toEqual([
      { dir: 'sent', message: { r: 1, a: 'gauth', b: '<dropped>' } },
      { dir: 'received', message: { r: 1, b: { s: 'ok', d: '<dropped>' } } },
      { dir: 'sent', message: { r: 2, a: 'p', b: { p: `/${RUN_PATH}`, d: { a: 1 } } } },
      { dir: 'received', message: { r: 2, b: { s: 'ok', d: '' } } },
    ]);
    expect(JSON.stringify(recorder.messages)).not.toContain('ya29');
    expect(connection.requestNumber_).toBe(2);
  });

  test('the gRPC recorder keeps the request, the response, the status and trailer names, with per-run fields as placeholders', () => {
    type Listener = (status: unknown) => void;
    const listeners: Listener[] = [];
    const call = { on: (_event: string, listener: Listener) => { listeners.push(listener); return call; } };
    let answered: unknown;
    const prototype = {
      makeUnaryRequest(_method: unknown, _ser: unknown, _de: unknown, _arg: unknown, callback: (error: unknown, value?: unknown) => void) {
        callback(null, { commitTime: { seconds: '1', nanos: 2 }, transaction: Buffer.from('tx-1') });
        return call;
      },
      makeServerStreamRequest() { return call; },
      makeBidiStreamRequest() { return call; },
    };
    const recorder = new GrpcRecorder(newStamp(), new Placeholders(new Redactor()));
    const uninstall = recorder.install({ prototype } as unknown as Parameters<GrpcRecorder['install']>[0]);
    (prototype.makeUnaryRequest as (...args: unknown[]) => unknown)(
      '/google.firestore.v1.Firestore/Commit', null, null, { transaction: Buffer.from('tx-1') },
      (_error: unknown, value: unknown) => { answered = value; },
    );
    for (const listener of listeners) listener({ code: 6, details: 'Document already exists', metadata: { getMap: () => ({ 'x-debug': '1' }) } });
    uninstall();
    expect(answered).toBeDefined();
    expect(recorder.exchanges).toHaveLength(1);
    const [exchange] = recorder.exchanges;
    expect(exchange!.method).toBe('google.firestore.v1.Firestore/Commit');
    expect(exchange!.requests).toEqual([{ transaction: '<transaction-1>' }]);
    expect(exchange!.responses.map((r) => r.message)).toEqual([{ commitTime: '<commit-time-1>', transaction: '<transaction-1>' }]);
    expect(exchange!.status).toEqual({ code: 6, details: 'Document already exists', trailers: ['x-debug'] });
  });
});
