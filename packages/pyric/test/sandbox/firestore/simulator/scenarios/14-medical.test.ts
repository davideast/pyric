/**
 * Scenario 14: Medical Records
 *
 * 3-tier access (patient, doctor, admin), records created by assigned
 * doctors with isServerTimestamp (known simulator gap), records immutable,
 * only admin can delete records.
 * Stdlib: auth, membership, lifecycle, validation
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/internal/node';

const SOURCE = `import { isAuthenticated } from 'auth';
import { hasClaimRole } from 'membership';
import { fieldUnchanged, isServerTimestamp } from 'lifecycle';
import { hasRequired } from 'validation';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /patients/{patientId} {
      // Admin can do everything on patients
      allow read: if isAuthenticated()
          && (request.auth.uid == patientId
              || hasClaimRole('role', 'admin'));
      allow create: if isAuthenticated()
          && hasClaimRole('role', 'admin')
          && hasRequired(['name', 'dob', 'createdAt'])
          && isServerTimestamp('createdAt');
      allow update: if isAuthenticated()
          && hasClaimRole('role', 'admin')
          && fieldUnchanged('createdAt');
      allow delete: if false;

      match /records/{recordId} {
        // Patient reads own, assigned doctor reads, admin reads all
        allow read: if isAuthenticated()
            && (request.auth.uid == patientId
                || hasClaimRole('role', 'admin')
                || exists(/databases/$(database)/documents/assignments/$(patientId + '_' + request.auth.uid)));

        // Only assigned doctor can create records
        allow create: if isAuthenticated()
            && hasClaimRole('role', 'doctor')
            && request.resource.data.doctorId == request.auth.uid
            && exists(/databases/$(database)/documents/assignments/$(patientId + '_' + request.auth.uid))
            && hasRequired(['doctorId', 'diagnosis', 'notes', 'createdAt'])
            && isServerTimestamp('createdAt');

        // Records are immutable
        allow update: if false;

        // Only admin can delete records
        allow delete: if isAuthenticated()
            && hasClaimRole('role', 'admin');
      }
    }

    match /assignments/{assignmentId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaimRole('role', 'admin')
          && hasRequired(['patientId', 'doctorId']);
      allow update: if false;
      allow delete: if isAuthenticated()
          && hasClaimRole('role', 'admin');
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 14: Medical Records', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'patients/patient1': { name: 'Jane Doe', dob: '1990-01-15', createdAt: 'SERVER_TS' },
        'patients/patient1/records/r1': { doctorId: 'doc1', diagnosis: 'Flu', notes: 'Rest recommended', createdAt: 'SERVER_TS' },
        'assignments/patient1_doc1': { patientId: 'patient1', doctorId: 'doc1' },
      },
    });
    return env;
  }

  // ═══ ALLOW ═══

  test('admin updates patient', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'patients/patient1', auth: { uid: 'admin1', token: { role: 'admin' } }, data: { name: 'Jane Smith', createdAt: 'SERVER_TS' } });
    expect(r.allowed).toBe(true);
  });

  test('admin creates assignment', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'assignments/patient1_doc2', auth: { uid: 'admin1', token: { role: 'admin' } }, data: { patientId: 'patient1', doctorId: 'doc2' } });
    expect(r.allowed).toBe(true);
  });

  test('admin deletes record', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'patients/patient1/records/r1', auth: { uid: 'admin1', token: { role: 'admin' } } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('doctor cannot create patient', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'patients/patient2', auth: { uid: 'doc1', token: { role: 'doctor' } }, data: { name: 'John', dob: '1985-03-20', createdAt: 'SERVER_TS' } });
    expect(r.allowed).toBe(false);
  });

  test('unassigned doctor denied record create', () => {
    const env = makeEnv();
    // doc2 is not assigned to patient1 (no assignment doc)
    const r = env.execute({ method: 'create', path: 'patients/patient1/records/r2', auth: { uid: 'doc2', token: { role: 'doctor' } }, data: { doctorId: 'doc2', diagnosis: 'Cold', notes: 'Drink fluids', createdAt: 'SERVER_TS' } });
    expect(r.allowed).toBe(false);
  });

  test('records are immutable (update denied)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'patients/patient1/records/r1', auth: { uid: 'doc1', token: { role: 'doctor' } }, data: { notes: 'Tampered' } });
    expect(r.allowed).toBe(false);
  });

  test('patient cannot delete own records', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'patients/patient1/records/r1', auth: { uid: 'patient1' } });
    expect(r.allowed).toBe(false);
  });

  test('patient delete blocked', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'delete', path: 'patients/patient1', auth: { uid: 'patient1' } });
    expect(r.allowed).toBe(false);
  });

  test('doctorId spoof denied', () => {
    const env = makeEnv();
    // doc1 is assigned but tries to set doctorId to doc2
    const r = env.execute({ method: 'create', path: 'patients/patient1/records/r3', auth: { uid: 'doc1', token: { role: 'doctor' } }, data: { doctorId: 'doc2', diagnosis: 'Spoof', notes: 'Fake', createdAt: 'SERVER_TS' } });
    expect(r.allowed).toBe(false);
  });

  test('createdAt tamper denied on patient update', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'patients/patient1', auth: { uid: 'admin1', token: { role: 'admin' } }, data: { name: 'Jane Smith', createdAt: 'FAKE_TS' } });
    expect(r.allowed).toBe(false);
  });

  test('outsider cannot create assignment', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'assignments/patient1_doc3', auth: { uid: 'doc1', token: { role: 'doctor' } }, data: { patientId: 'patient1', doctorId: 'doc3' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'assignments/patient1_doc4', auth: null, data: { patientId: 'patient1', doctorId: 'doc4' } });
    expect(r.allowed).toBe(false);
  });

  // ═══ isServerTimestamp — FIXED via { __type: 'serverTimestamp' } sentinel ═══

  test('admin creates patient with serverTimestamp', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'patients/patient2', auth: { uid: 'admin1', token: { role: 'admin' } }, data: { name: 'John', dob: '1985-03-20', createdAt: { __type: 'serverTimestamp' } } });
    expect(r.allowed).toBe(true);
  });

  test('doctor creates record with serverTimestamp', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'create', path: 'patients/patient1/records/r4', auth: { uid: 'doc1', token: { role: 'doctor' } }, data: { doctorId: 'doc1', diagnosis: 'Checkup', notes: 'All clear', createdAt: { __type: 'serverTimestamp' } } });
    expect(r.allowed).toBe(true);
  });
});
