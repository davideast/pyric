/**
 * ─── Scenario 2: functions-let-scope ────────────────────────────────────────────
 * #96/#104 also claim user-defined functions are unsupported. This proves
 * `let` bindings, functions calling functions, and match-block-scoped helper
 * functions (lexical scoping). A call to an undefined function compiles with
 * the warning "Invalid function name" and is a "Function not found error" at
 * evaluation, so `|| true` absorbs it and a call that decides the rule denies.
 *
 * Errors passed into functions and `let` bindings: production binds an
 * argument or `let` value that errors and evaluates the function body. The
 * error decides the verdict only where the body reads it, so a function that
 * ignores the argument grants, also when the argument passes through a
 * second call. The error generators are an int division by
 * `request.resource.size`, which is 0 ("Divide by zero error."), and a method
 * an int does not define.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-FUNC',
  rationale:
    'User-defined functions with let bindings, functions calling functions, and a match-block-scoped helper — the evaluator surface #96/#104 wrongly call unsupported.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function sizeUnder(limitMb) {
      let mb = 1024 * 1024;
      return request.resource.size < limitMb * mb;
    }
    function isImage() {
      return request.resource.contentType == 'image/png';
    }
    function allowedUpload() {
      return sizeUnder(5) && isImage();
    }
    match /uploads/{fileId} {
      allow create: if allowedUpload();
    }
    match /scoped/{fileId} {
      function tooBig() {
        return request.resource.size > 1024;
      }
      allow create: if !tooBig();
    }
    match /undeclared/{fileId} {
      function ownerOrUndeclared() {
        return request.auth.uid == 'a' || notDeclared();
      }
      allow read: if ownerOrUndeclared();
    }
    function ignoresArg(a) { return true; }
    function readsArg(a) { return a > 0; }
    function passesToIgnoresArg(a) { return ignoresArg(a); }
    function passesToReadsArg(a) { return readsArg(a); }
    function letUnread() { let x = 1 / request.resource.size; return true; }
    function letRead() { let x = 1 / request.resource.size; return x > 0; }
    match /argUnread/{fileId} {
      allow create: if ignoresArg(1 / request.resource.size);
    }
    match /argRead/{fileId} {
      allow create: if readsArg(1 / request.resource.size);
    }
    match /argThroughTwoCallsUnread/{fileId} {
      allow create: if passesToIgnoresArg(1 / request.resource.size);
    }
    match /argThroughTwoCallsRead/{fileId} {
      allow create: if passesToReadsArg(1 / request.resource.size);
    }
    match /argMethodErrorUnread/{fileId} {
      allow create: if ignoresArg(request.resource.size.hours());
    }
    match /letUnread/{fileId} {
      allow create: if letUnread();
    }
    match /letRead/{fileId} {
      allow create: if letRead();
    }
  }
}`,
  cases: [
    { description: 'let + nested calls: small png under 5MB', expectation: 'ALLOW', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/png' } },
    { description: 'let + nested calls: oversized png denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 10485760, contentType: 'image/png' } },
    { description: 'nested call isImage(): wrong content type denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/jpeg' } },
    { description: 'block-scoped helper tooBig(): small file allowed', expectation: 'ALLOW', method: 'create', path: 'scoped/b.bin', resource: { size: 500, contentType: 'application/octet-stream' } },
    { description: 'block-scoped helper tooBig(): large file denied', expectation: 'DENY', method: 'create', path: 'scoped/b.bin', resource: { size: 5000, contentType: 'application/octet-stream' } },
    { description: 'undefined function after a true || operand: allowed', expectation: 'ALLOW', method: 'get', path: 'undeclared/c.bin', auth: { uid: 'a' }, existingResource: { size: 100 } },
    { description: 'undefined function that decides the rule: denied', expectation: 'DENY', method: 'get', path: 'undeclared/c.bin', auth: { uid: 'b' }, existingResource: { size: 100 } },
    ...([
      ['argUnread', 'an erroring argument the function never reads: allowed', 'ALLOW'],
      ['argRead', 'an erroring argument the function reads: denied', 'DENY'],
      ['argThroughTwoCallsUnread', 'an erroring argument passed through two calls and never read: allowed', 'ALLOW'],
      ['argThroughTwoCallsRead', 'an erroring argument passed through two calls and read: denied', 'DENY'],
      ['argMethodErrorUnread', 'an argument calling a method an int lacks, never read: allowed', 'ALLOW'],
      ['letUnread', 'an erroring let the function never reads: allowed', 'ALLOW'],
      ['letRead', 'an erroring let the function reads: denied', 'DENY'],
    ] as const).map(([folder, description, expectation]) => ({
      description,
      expectation,
      method: 'create' as const,
      path: `${folder}/d.bin`,
      resource: { size: 0, contentType: 'application/octet-stream' },
    })),
  ],
};
