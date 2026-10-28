import { expect, test } from 'bun:test';
import { doc } from '../../../src/serve/worker/client/firestore-refs.js';
import { setDoc } from '../../../src/serve/worker/client/firestore-writes.js';
import { getStorage, ref as storageRef, uploadBytes } from '../../../src/serve/worker/client/storage.js';
import { uploadBytesResumable } from '../../../src/serve/worker/client/resumable.js';
import {
  messagingDeleteToken,
  messagingGetMessaging,
  messagingSetVisibility,
  messagingSubscribe,
} from '../../../src/serve/worker/client/messaging.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';
import { attached, barrier, gate, GatedBlob, Host } from './hosted-call-order-support.js';

// ADR-0019, 2026-10-17 amendment. D1: operations the app issues in program
// order reach the host in that order, across services. D2: each operation is
// sent, held or failed before the call returns. The client runs against a real
// WebSocket host on a loopback port, and order is read from the host's frames.

test('uploadBytesResumable then setDoc reach the host in call order', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const task = uploadBytesResumable(storageRef(getStorage(db), 'a.bin'), new Uint8Array([1, 2, 3]));
  const write = setDoc(doc(db, 'rooms/r1'), { a: 1 });
  await Promise.all([task, write]);
  expect(host.methods('storage.putBytes', 'setDoc')).toEqual(['storage.putBytes', 'setDoc']);
});

test('uploadBytesResumable on a byte route begins the upload before it returns', () => {
  const posted: InboundMessage[] = [];
  const port: ClientPort = {
    onmessage: null,
    postMessage: message => { posted.push(message); },
    start() {},
    close() {},
    byteRoute: { baseUrl: 'http://127.0.0.1:1/', sessionToken: async () => 'session' },
  };
  const task = uploadBytesResumable(storageRef(getStorage({ __kind: 'client-db', port }), 'routed.bin'), new Uint8Array([1]));
  task.catch(() => {});
  expect(posted.map(message => ('method' in message ? message.method : message.t))).toEqual(['storage.beginUpload']);
});

test('a resumable upload paused while its single frame is in flight completes on resume without sending again', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const task = uploadBytesResumable(storageRef(getStorage(db), 'paused.bin'), new Uint8Array([1, 2, 3]));
  task.pause();
  await barrier(db);
  expect(task.snapshot.state).toBe('paused');
  task.resume();
  const snapshot = await task;
  await barrier(db);
  expect(snapshot.state).toBe('success');
  expect(host.methods('storage.putBytes', 'storage.deleteObject')).toEqual(['storage.putBytes']);
});

test('uploadBytes(Blob) then setDoc reach the host in call order', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const upload = uploadBytes(storageRef(getStorage(db), 'b.bin'), new Blob([new Uint8Array([1])]));
  const write = setDoc(doc(db, 'rooms/r2'), { a: 1 });
  await Promise.all([upload, write]);
  expect(host.methods('storage.putBytes', 'setDoc')).toEqual(['storage.putBytes', 'setDoc']);
});

test('operations after uploadBytes(Blob) wait for its bytes and go once they are read', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const blob = new GatedBlob([new Uint8Array([1])]);
  const upload = uploadBytes(storageRef(getStorage(db), 'slow.bin'), blob);
  const write = setDoc(doc(db, 'rooms/r3'), { a: 1 });
  blob.read.open(new Uint8Array([7]).buffer);
  await Promise.all([upload, write]);
  expect(host.methods('storage.putBytes', 'setDoc')).toEqual(['storage.putBytes', 'setDoc']);
});

test('a Blob that cannot be read fails its upload and lets later operations go', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const blob = new GatedBlob([new Uint8Array([1])]);
  const upload = uploadBytes(storageRef(getStorage(db), 'unreadable.bin'), blob).then(() => 'stored', (error: Error) => error.message);
  const write = setDoc(doc(db, 'rooms/r4'), { a: 1 });
  blob.read.fail(new Error('NotReadableError'));
  expect(await upload).toBe('NotReadableError');
  await write;
  expect(host.methods('storage.putBytes', 'setDoc')).toEqual(['setDoc']);
});

test('Messaging deleteToken then setDoc reach the host in call order', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const messaging = messagingGetMessaging(db);
  await messaging.registrationId;
  const deleted = messagingDeleteToken(messaging);
  const write = setDoc(doc(db, 'rooms/r5'), { a: 1 });
  await Promise.all([deleted, write]);
  expect(host.methods('messaging.deleteToken', 'setDoc')).toEqual(['messaging.deleteToken', 'setDoc']);
});

test('a Messaging op issued before the registration id settles keeps its place ahead of later operations', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const registration = gate<string>();
  const messaging = messagingGetMessaging(db, () => registration.promise);
  const deleted = messagingDeleteToken(messaging);
  const write = setDoc(doc(db, 'rooms/r6'), { a: 1 });
  registration.open('swreg-late');
  await Promise.all([deleted, write]);
  expect(host.methods('messaging.deleteToken', 'setDoc')).toEqual(['messaging.deleteToken', 'setDoc']);
});

test('the client\'s own visibility sync holds no other service, and still goes before later Messaging ops', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const registration = gate<string>();
  const messaging = messagingGetMessaging(db, () => registration.promise);
  const visibility = messagingSetVisibility(messaging, 'visible');
  await setDoc(doc(db, 'rooms/r7'), { a: 1 });
  const deleted = messagingDeleteToken(messaging);
  registration.open('swreg-late');
  await Promise.all([visibility, deleted]);
  expect(host.methods('setDoc', 'messaging.setVisibility', 'messaging.deleteToken'))
    .toEqual(['setDoc', 'messaging.setVisibility', 'messaging.deleteToken']);
});

test('a registration id that fails lets later operations go', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const registration = gate<string>();
  const messaging = messagingGetMessaging(db, () => registration.promise);
  const deleted = messagingDeleteToken(messaging).then(() => 'deleted', (error: Error) => error.message);
  const write = setDoc(doc(db, 'rooms/r8'), { a: 1 });
  registration.fail(new Error('Messaging installation storage is blocked.'));
  expect(await deleted).toBe('Messaging installation storage is blocked.');
  await write;
  expect(host.methods('messaging.deleteToken', 'setDoc')).toEqual(['setDoc']);
});

test('onMessage then setDoc: the Messaging worker-sub reaches the host first', async () => {
  const host = new Host();
  const { db } = await attached(host);
  const messaging = messagingGetMessaging(db);
  await messaging.registrationId;
  const stop = messagingSubscribe(messaging, 'messaging.foreground', () => {});
  await setDoc(doc(db, 'rooms/r9'), { a: 1 });
  stop();
  const order = host.frames.map(frame => frame.method ?? frame.t).filter(kind => kind === 'sub' || kind === 'setDoc');
  expect(order).toEqual(['sub', 'setDoc']);
});
