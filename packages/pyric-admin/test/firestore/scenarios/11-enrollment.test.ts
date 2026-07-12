/**
 * Scenario 11: Student Enrollment
 *
 * Teachers create courses, students enroll in open courses, grading via
 * get() to verify teacherId, MapDiff to constrain which fields change.
 * Stdlib: auth, validation, lifecycle, membership
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/internal/node';
import { makeRoot, runOp } from './_helpers.js';

const SOURCE = `import { isAuthenticated } from 'auth';
import { hasRequired, hasOnly } from 'validation';
import { fieldUnchanged } from 'lifecycle';
import { hasClaim } from 'membership';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /courses/{courseId} {
      allow read: if isAuthenticated();
      allow create: if isAuthenticated()
          && hasClaim('role_teacher')
          && request.resource.data.teacherId == request.auth.uid
          && hasRequired(['title', 'teacherId', 'status'])
          && hasOnly(['title', 'teacherId', 'status', 'description']);
      allow update: if isAuthenticated()
          && hasClaim('role_teacher')
          && resource.data.teacherId == request.auth.uid
          && fieldUnchanged('teacherId');
      allow delete: if isAuthenticated()
          && hasClaim('role_teacher')
          && resource.data.teacherId == request.auth.uid
          && resource.data.status == 'open';
    }

    match /enrollments/{enrollmentId} {
      allow read: if isAuthenticated();

      // Student enrolls: course must be open, studentId must match auth
      allow create: if isAuthenticated()
          && request.resource.data.studentId == request.auth.uid
          && request.resource.data.status == 'enrolled'
          && hasRequired(['studentId', 'courseId', 'status'])
          && hasOnly(['studentId', 'courseId', 'status'])
          && get(/databases/$(database)/documents/courses/$(request.resource.data.courseId)).data.status == 'open';

      // Teacher grades: only the course teacher, MapDiff allows ONLY grade change
      allow update: if isAuthenticated()
          && hasClaim('role_teacher')
          && get(/databases/$(database)/documents/courses/$(resource.data.courseId)).data.teacherId == request.auth.uid
          && request.resource.data.status == resource.data.status
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['grade']);

      // Student withdraws: MapDiff allows ONLY status change to 'withdrawn'
      allow update: if isAuthenticated()
          && resource.data.studentId == request.auth.uid
          && request.resource.data.status == 'withdrawn'
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status']);

      allow delete: if false;
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

const SEED = {
  'courses/c1': { title: 'Math 101', teacherId: 'teacher1', status: 'open', description: 'Intro math' },
  'courses/c2': { title: 'History 201', teacherId: 'teacher2', status: 'closed' },
  'enrollments/e1': { studentId: 'student1', courseId: 'c1', status: 'enrolled' },
  'enrollments/e2': { studentId: 'student2', courseId: 'c1', status: 'enrolled', grade: 'B' },
};

describe('Scenario 11: Student Enrollment', () => {
  // ═══ ALLOW ═══

  test('teacher creates course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'courses/c3', auth: { uid: 'teacher1', token: { role_teacher: true } }, data: { title: 'Science 301', teacherId: 'teacher1', status: 'open' } });
    expect(r.allowed).toBe(true);
  });

  test('teacher updates own course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'courses/c1', auth: { uid: 'teacher1', token: { role_teacher: true } }, data: { title: 'Math 102', teacherId: 'teacher1', status: 'open', description: 'Updated' } });
    expect(r.allowed).toBe(true);
  });

  test('student enrolls in open course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'enrollments/e3', auth: { uid: 'student3' }, data: { studentId: 'student3', courseId: 'c1', status: 'enrolled' } });
    expect(r.allowed).toBe(true);
  });

  test('teacher grades enrollment (MapDiff)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'enrollments/e1', auth: { uid: 'teacher1', token: { role_teacher: true } }, data: { grade: 'A' } });
    expect(r.allowed).toBe(true);
  });

  test('student withdraws (MapDiff)', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'enrollments/e1', auth: { uid: 'student1' }, data: { status: 'withdrawn' } });
    expect(r.allowed).toBe(true);
  });

  test('teacher deletes open course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'courses/c1', auth: { uid: 'teacher1', token: { role_teacher: true } } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('student cannot create course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'courses/c4', auth: { uid: 'student1' }, data: { title: 'Fake', teacherId: 'student1', status: 'open' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot enroll in closed course', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'enrollments/e4', auth: { uid: 'student1' }, data: { studentId: 'student1', courseId: 'c2', status: 'enrolled' } });
    expect(r.allowed).toBe(false);
  });

  test('wrong teacher cannot grade', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'enrollments/e1', auth: { uid: 'teacher2', token: { role_teacher: true } }, data: { grade: 'F' } });
    expect(r.allowed).toBe(false);
  });

  test('cannot delete enrollment', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'delete', path: 'enrollments/e1', auth: { uid: 'student1' } });
    expect(r.allowed).toBe(false);
  });

  test('grade+status combo blocked by MapDiff', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'enrollments/e1', auth: { uid: 'teacher1', token: { role_teacher: true } }, data: { grade: 'A', status: 'withdrawn' } });
    expect(r.allowed).toBe(false);
  });

  test('grade change during withdrawal blocked', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'update', path: 'enrollments/e1', auth: { uid: 'student1' }, data: { status: 'withdrawn', grade: 'A+' } });
    expect(r.allowed).toBe(false);
  });

  test('enroll someone else denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'enrollments/e5', auth: { uid: 'student1' }, data: { studentId: 'student2', courseId: 'c1', status: 'enrolled' } });
    expect(r.allowed).toBe(false);
  });

  test('unauthorized field on course denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'courses/c5', auth: { uid: 'teacher1', token: { role_teacher: true } }, data: { title: 'Art', teacherId: 'teacher1', status: 'open', secret: 'hack' } });
    expect(r.allowed).toBe(false);
  });

  test('pre-set grade on enrollment denied', async () => {
    const root = makeRoot(RULES, SEED);
    const r = await runOp(root, { method: 'create', path: 'enrollments/e6', auth: { uid: 'student1' }, data: { studentId: 'student1', courseId: 'c1', status: 'enrolled', grade: 'A+' } });
    expect(r.allowed).toBe(false);
  });
});
