/**
 * Scenario 12: IoT Device Telemetry
 *
 * Device owner management, append-only telemetry subcollection,
 * device active check via get(), range validation for sensor data.
 * Stdlib: auth, lifecycle, validation
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

const SOURCE = `import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
import { hasRequired } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /devices/{deviceId} {
      allow read: if isAuthenticated()
          && resource.data.ownerId == request.auth.uid;
      allow create: if isAuthenticated()
          && request.resource.data.ownerId == request.auth.uid
          && hasRequired(['ownerId', 'name', 'active']);
      allow update: if isAuthenticated()
          && resource.data.ownerId == request.auth.uid
          && fieldUnchanged('ownerId');
      allow delete: if isAuthenticated()
          && resource.data.ownerId == request.auth.uid;

      match /telemetry/{entryId} {
        allow read: if isAuthenticated()
            && get(/databases/$(database)/documents/devices/$(deviceId)).data.ownerId == request.auth.uid;

        // Append-only: create only, no update or delete
        allow create: if isAuthenticated()
            && get(/databases/$(database)/documents/devices/$(deviceId)).data.ownerId == request.auth.uid
            && get(/databases/$(database)/documents/devices/$(deviceId)).data.active == true
            && request.resource.data.deviceId == deviceId
            && hasRequired(['temperature', 'humidity', 'deviceId', 'timestamp'])
            && request.resource.data.temperature >= -50
            && request.resource.data.temperature <= 150
            && request.resource.data.humidity >= 0
            && request.resource.data.humidity <= 100;

        allow update: if false;
        allow delete: if false;
      }
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 12: IoT Device Telemetry', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'devices/d1': { ownerId: 'user1', name: 'Thermostat', active: true },
        'devices/d2': { ownerId: 'user2', name: 'Sensor', active: true },
        'devices/d3': { ownerId: 'user1', name: 'Inactive Sensor', active: false },
        'devices/d1/telemetry/t1': { temperature: 22.5, humidity: 45, deviceId: 'd1', timestamp: 1000 },
      },
    });
    return env;
  }

  // ═══ ALLOW ═══

  test('owner creates device', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d4', auth: { uid: 'user1' }, data: { ownerId: 'user1', name: 'New Sensor', active: true } });
    expect(r.allowed).toBe(true);
  });

  test('owner updates device', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'devices/d1', auth: { uid: 'user1' }, data: { name: 'Updated Thermostat' } });
    expect(r.allowed).toBe(true);
  });

  test('owner writes telemetry', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t2', auth: { uid: 'user1' }, data: { temperature: 23.0, humidity: 50, deviceId: 'd1', timestamp: 2000 } });
    expect(r.allowed).toBe(true);
  });

  test('owner deletes device', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'devices/d1', auth: { uid: 'user1' } });
    expect(r.allowed).toBe(true);
  });

  test('boundary temp 150 allowed', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t3', auth: { uid: 'user1' }, data: { temperature: 150, humidity: 50, deviceId: 'd1', timestamp: 3000 } });
    expect(r.allowed).toBe(true);
  });

  test('boundary temp -50 allowed', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t4', auth: { uid: 'user1' }, data: { temperature: -50, humidity: 50, deviceId: 'd1', timestamp: 4000 } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('non-owner update denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'devices/d1', auth: { uid: 'user2' }, data: { name: 'Hacked' } });
    expect(r.allowed).toBe(false);
  });

  test('inactive device telemetry denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d3/telemetry/t5', auth: { uid: 'user1' }, data: { temperature: 20, humidity: 40, deviceId: 'd3', timestamp: 5000 } });
    expect(r.allowed).toBe(false);
  });

  test('telemetry update immutable', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'devices/d1/telemetry/t1', auth: { uid: 'user1' }, data: { temperature: 99 } });
    expect(r.allowed).toBe(false);
  });

  test('telemetry delete immutable', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'devices/d1/telemetry/t1', auth: { uid: 'user1' } });
    expect(r.allowed).toBe(false);
  });

  test('create device for someone else denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d5', auth: { uid: 'user1' }, data: { ownerId: 'user2', name: 'Stolen', active: true } });
    expect(r.allowed).toBe(false);
  });

  test('change ownerId denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'devices/d1', auth: { uid: 'user1' }, data: { ownerId: 'user2' } });
    expect(r.allowed).toBe(false);
  });

  test('temp too high denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t6', auth: { uid: 'user1' }, data: { temperature: 151, humidity: 50, deviceId: 'd1', timestamp: 6000 } });
    expect(r.allowed).toBe(false);
  });

  test('humidity negative denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t7', auth: { uid: 'user1' }, data: { temperature: 20, humidity: -1, deviceId: 'd1', timestamp: 7000 } });
    expect(r.allowed).toBe(false);
  });

  test('wrong deviceId denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t8', auth: { uid: 'user1' }, data: { temperature: 20, humidity: 50, deviceId: 'wrong', timestamp: 8000 } });
    expect(r.allowed).toBe(false);
  });

  test('non-owner telemetry denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'devices/d1/telemetry/t9', auth: { uid: 'user2' }, data: { temperature: 20, humidity: 50, deviceId: 'd1', timestamp: 9000 } });
    expect(r.allowed).toBe(false);
  });
});
