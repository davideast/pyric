/**
 * ─── Scenario 2: functions-let-scope ────────────────────────────────────────────
 * #96/#104 also claim user-defined functions are unsupported. This proves
 * `let` bindings, functions calling functions, and match-block-scoped helper
 * functions (lexical scoping). Same-name shadowing and undefined-function
 * calls are deliberately omitted: production rejects those at compile, so they
 * cannot be captured as a clean verdict (they live in the evaluator unit tests).
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
  }
}`,
  cases: [
    { description: 'let + nested calls: small png under 5MB', expectation: 'ALLOW', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/png' } },
    { description: 'let + nested calls: oversized png denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 10485760, contentType: 'image/png' } },
    { description: 'nested call isImage(): wrong content type denied', expectation: 'DENY', method: 'create', path: 'uploads/a.png', resource: { size: 1048576, contentType: 'image/jpeg' } },
    { description: 'block-scoped helper tooBig(): small file allowed', expectation: 'ALLOW', method: 'create', path: 'scoped/b.bin', resource: { size: 500, contentType: 'application/octet-stream' } },
    { description: 'block-scoped helper tooBig(): large file denied', expectation: 'DENY', method: 'create', path: 'scoped/b.bin', resource: { size: 5000, contentType: 'application/octet-stream' } },
  ],
};
