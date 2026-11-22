/**
 * #1456: `sandbox.fork` refuses candidate rulesets that production's load check
 * refuses before creating or saving the branch directory.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { BRANCH_STORE_RELATIVE } from 'pyric/sandbox/branches/store';
import { setRules } from 'pyric/sandbox/firestore';

import {
  createSurfaceContext,
  renderSurface,
  type OperationResult,
  type SurfaceContext,
} from '../../../../../src/bridge/surface/index.js';

const OPEN_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if true; }',
  '  }',
  '}',
].join('\n');

const DUPLICATE_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /a/{id} { allow read: if true; }',
  '  }',
  '}',
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /b/{id} { allow read: if true; }',
  '  }',
  '}',
].join('\n');

const BROKEN_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /a/{id} { allow read: if true }',
  '  }',
  '}',
].join('\n');

const surface = renderSurface(undefined);

let projectDir: string;
let sandbox: LocalSandbox;
let ctx: SurfaceContext;

async function run(key: string, args: Record<string, unknown> = {}): Promise<OperationResult> {
  const [toolName, method] = key.split('.');
  const tool = surface.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new Error(`no rendered tool named ${toolName}`);
  }
  return tool.execute({ method, args }, ctx);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-fork-candidate-rules-'));
  sandbox = initializeSandbox();
  setRules(sandbox, OPEN_FIRESTORE_RULES);
  ctx = createSurfaceContext(sandbox, projectDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('sandbox.fork candidateRules load check (#1456)', () => {
  it('refuses unparseable Firestore candidateRules string and leaves no branch on disk', async () => {
    const res = await run('sandbox.fork', {
      branch: 'syntax-error',
      candidateRules: BROKEN_FIRESTORE_RULES,
    });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('Firestore rules did not parse');
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'syntax-error'))).toBe(false);
  });

  it('refuses duplicate-service Firestore candidateRules (string and object forms) with production reason', async () => {
    const strRes = await run('sandbox.fork', {
      branch: 'dup-string',
      candidateRules: DUPLICATE_FIRESTORE_RULES,
    });
    expect(strRes.ok).toBe(false);
    expect(strRes.summary).toContain('Firestore rules did not compile: Duplicate service name declaration.');
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'dup-string'))).toBe(false);

    const objRes = await run('sandbox.fork', {
      branch: 'dup-object',
      candidateRules: { firestore: DUPLICATE_FIRESTORE_RULES },
    });
    expect(objRes.ok).toBe(false);
    expect(objRes.summary).toContain('Firestore rules did not compile: Duplicate service name declaration.');
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'dup-object'))).toBe(false);
  });

  it('refuses invalid Realtime Database and Storage candidateRules before saving the branch', async () => {
    const badRtdb = await run('sandbox.fork', {
      branch: 'bad-rtdb',
      candidateRules: { database: { rules: { items: { '.read': 'auth.uid ===' } } } },
    });
    expect(badRtdb.ok).toBe(false);
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'bad-rtdb'))).toBe(false);

    const badStorage = await run('sandbox.fork', {
      branch: 'bad-storage',
      candidateRules: { storage: BROKEN_FIRESTORE_RULES },
    });
    expect(badStorage.ok).toBe(false);
    expect(badStorage.summary).toContain('Storage');
    expect(existsSync(join(projectDir, BRANCH_STORE_RELATIVE, 'bad-storage'))).toBe(false);
  });
});
