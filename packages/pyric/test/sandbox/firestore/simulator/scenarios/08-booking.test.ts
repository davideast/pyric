/**
 * Scenario 8: Booking System
 *
 * Room references via exists(), time validation, status transitions,
 * immutable fields on cancel, no direct delete.
 * Stdlib: auth, transitions, lifecycle
 *
 * Rules: inline
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

const SOURCE = `import { isAuthenticated } from 'auth';
import { validTransition } from 'transitions';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      allow read: if true;
      allow write: if false;
    }
    match /bookings/{bookingId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && request.resource.data.roomId != ''
          && exists(/databases/$(database)/documents/rooms/$(request.resource.data.roomId))
          && request.resource.data.startTime < request.resource.data.endTime
          && request.resource.data.startTime != request.resource.data.endTime
          && request.resource.data.status == 'active'
          && request.resource.data.createdBy == request.auth.uid;
      allow update: if isAuthenticated()
          && resource.data.createdBy == request.auth.uid
          && validTransition('status', 'active', 'cancelled')
          && fieldUnchanged('roomId')
          && fieldUnchanged('startTime')
          && fieldUnchanged('endTime')
          && fieldUnchanged('createdBy');
      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 8: Booking System', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'rooms/conf-a': { name: 'Conference A', capacity: 10 },
        'rooms/conf-b': { name: 'Conference B', capacity: 6 },
        'bookings/b1': { roomId: 'conf-a', startTime: '2026-04-11T09:00:00Z', endTime: '2026-04-11T10:00:00Z', status: 'active', createdBy: 'alice' },
        'bookings/b2': { roomId: 'conf-b', startTime: '2026-04-11T14:00:00Z', endTime: '2026-04-11T15:00:00Z', status: 'cancelled', createdBy: 'bob' },
      },
    });
    return env;
  }

  test('valid booking', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b3', auth: { uid: 'carol' }, data: { roomId: 'conf-a', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'carol' } });
    expect(r.allowed).toBe(true);
  });

  test('cancel own booking', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'bookings/b1', auth: { uid: 'alice' }, data: { status: 'cancelled' } });
    expect(r.allowed).toBe(true);
  });

  test('different times ok', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b4', auth: { uid: 'alice' }, data: { roomId: 'conf-b', startTime: '2026-04-13T08:00:00Z', endTime: '2026-04-13T17:00:00Z', status: 'active', createdBy: 'alice' } });
    expect(r.allowed).toBe(true);
  });

  test('start after end denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b5', auth: { uid: 'alice' }, data: { roomId: 'conf-a', startTime: '2026-04-12T11:00:00Z', endTime: '2026-04-12T09:00:00Z', status: 'active', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('zero duration denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b6', auth: { uid: 'alice' }, data: { roomId: 'conf-a', startTime: '2026-04-12T10:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('non-existent room denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b7', auth: { uid: 'alice' }, data: { roomId: 'conf-z', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('non-creator cancel denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'bookings/b1', auth: { uid: 'bob' }, data: { status: 'cancelled' } });
    expect(r.allowed).toBe(false);
  });

  test('delete blocked', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'bookings/b1', auth: { uid: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('create for someone else denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b8', auth: { uid: 'alice' }, data: { roomId: 'conf-a', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'bob' } });
    expect(r.allowed).toBe(false);
  });

  test('non-active status on create denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b9', auth: { uid: 'alice' }, data: { roomId: 'conf-a', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'cancelled', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });

  test('roomId change on cancel denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'bookings/b1', auth: { uid: 'alice' }, data: { status: 'cancelled', roomId: 'conf-b' } });
    expect(r.allowed).toBe(false);
  });

  test('time change on cancel denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'bookings/b1', auth: { uid: 'alice' }, data: { status: 'cancelled', startTime: '2026-04-11T08:00:00Z' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b10', auth: null, data: { roomId: 'conf-a', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'anon' } });
    expect(r.allowed).toBe(false);
  });

  test('empty roomId denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'bookings/b11', auth: { uid: 'alice' }, data: { roomId: '', startTime: '2026-04-12T09:00:00Z', endTime: '2026-04-12T10:00:00Z', status: 'active', createdBy: 'alice' } });
    expect(r.allowed).toBe(false);
  });
});
