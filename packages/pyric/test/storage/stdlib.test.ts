import { describe, expect, it } from 'bun:test';
import { resolveModulesBrowser } from '../../src/rules/modules/resolver-browser.ts';
import { parseStorageRules, type EvaluationInput } from '../../src/storage/sandbox/rules.ts';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.ts';

function evaluateModule(
  moduleName: string,
  functions: string[],
  condition: string,
  input: EvaluationInput,
  now = new Date('2026-07-21T00:00:00Z'),
): boolean {
  const source = `rules_version = '2+modules';
import { ${functions.join(', ')} } from '${moduleName}';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} { allow write: if ${condition}; }
  }
}`;
  const resolved = resolveModulesBrowser(source);
  if (!resolved.success) {
    throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  }
  return evaluateStorageRules(parseStorageRules(resolved.data.resolved), input, now).allowed;
}

const createInput = (overrides: Partial<NonNullable<EvaluationInput['request']['resource']>> = {}): EvaluationInput => ({
  request: {
    auth: { uid: 'alice' },
    method: 'create',
    path: 'b/test/o/uploads/file.bin',
    resource: { size: 10, contentType: 'image/png', metadata: {}, ...overrides },
  },
  resource: null,
});

describe('Storage stdlib modules', () => {
  it('rejects Storage-only modules from a Firestore target', () => {
    const result = resolveModulesBrowser(`rules_version = '2+modules';
import { sizeAtMost } from 'storage/uploads';
service cloud.firestore {
  match /databases/{database}/documents { match /x/{id} { allow create: if sizeAtMost(10); } }
}`);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
  });

  it('storage/uploads composes inclusive size and MIME policies', () => {
    const functions = ['sizeAtMost', 'sizeBetween', 'contentTypeMatches', 'contentTypeIsOneOf'];
    const condition = "sizeAtMost(10) && sizeBetween(1, 10)"
      + " && contentTypeMatches('image/(png|jpeg)')"
      + " && contentTypeIsOneOf(['image/png', 'image/jpeg'])";

    expect(evaluateModule('storage/uploads', functions, condition, createInput())).toBe(true);
    expect(evaluateModule('storage/uploads', functions, condition, createInput({ size: 11 }))).toBe(false);
    expect(evaluateModule('storage/uploads', functions, condition, createInput({ contentType: 'image/png-extra' }))).toBe(false);
  });

  it('storage/metadata composes required keys, bounded strings, and ownership', () => {
    const functions = ['hasRequiredMetadata', 'metadataString', 'incomingMetadataOwner'];
    const condition = "hasRequiredMetadata(['owner', 'purpose'])"
      + " && metadataString('purpose', 3, 12)"
      + " && incomingMetadataOwner('owner')";
    const valid = createInput({ metadata: { owner: 'alice', purpose: 'avatar', extra: 'allowed' } });
    const missing = createInput({ metadata: { owner: 'alice' } });
    const wrongOwner = createInput({ metadata: { owner: 'bob', purpose: 'avatar' } });

    expect(evaluateModule('storage/metadata', functions, condition, valid)).toBe(true);
    expect(evaluateModule('storage/metadata', functions, condition, missing)).toBe(false);
    expect(evaluateModule('storage/metadata', functions, condition, wrongOwner)).toBe(false);
    expect(evaluateModule(
      'storage/metadata',
      ['existingMetadataOwner'],
      "existingMetadataOwner('owner')",
      {
        request: {
          auth: { uid: 'alice' },
          method: 'update',
          path: 'b/test/o/uploads/file.bin',
          resource: { size: 10, metadata: { owner: 'alice' } },
        },
        resource: { size: 10, metadata: { owner: 'alice' } },
      },
    )).toBe(true);
  });

  it('storage/objects identifies create, update, and delete without probing missing bindings', () => {
    const functions = ['isCreate', 'isUpdate', 'isDelete'];
    expect(evaluateModule('storage/objects', functions, 'isCreate() && !isUpdate() && !isDelete()', createInput())).toBe(true);
    expect(evaluateModule('storage/objects', functions, 'isUpdate()', {
      request: {
        auth: { uid: 'alice' },
        method: 'update',
        path: 'b/test/o/uploads/file.bin',
        resource: { size: 10 },
      },
      resource: { size: 9 },
    })).toBe(true);
    expect(evaluateModule('storage/objects', functions, 'isDelete()', {
      request: { auth: { uid: 'alice' }, method: 'delete', path: 'b/test/o/uploads/file.bin' },
      resource: { size: 10 },
    })).toBe(true);
  });

  it('storage/time applies strict creation and update freshness windows', () => {
    const input: EvaluationInput = {
      request: { auth: { uid: 'alice' }, method: 'delete', path: 'b/test/o/uploads/file.bin' },
      resource: {
        size: 10,
        timeCreated: '2026-07-21T00:00:00.000Z',
        updated: '2026-07-21T00:00:00.000Z',
      },
    };
    const functions = ['createdWithin', 'updatedWithin'];
    const condition = 'createdWithin(60) && updatedWithin(60)';

    expect(evaluateModule('storage/time', functions, condition, input, new Date('2026-07-21T00:00:59.999Z'))).toBe(true);
    expect(evaluateModule('storage/time', functions, condition, input, new Date('2026-07-21T00:01:00.000Z'))).toBe(false);
  });
});
