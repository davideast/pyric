import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore, collection, doc, getDoc, getDocs } from '../../src/firestore/index.js';
import { resolveModulesBrowser } from '../../src/rules/internal/index.js';

describe('DenialContext.rule authored source line citations (#370)', () => {
  it('simulate() evaluation denial carries clickable authored source line citation in DenialContext.rule', async () => {
    const rulesSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /posts/{id} {',
      '      allow read: if false;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const sandbox = initializeSandbox({ auth: { uid: 'alice' } });
    setRules(sandbox, rulesSource);
    const db = getFirestore(sandbox);

    let caught: unknown;
    try {
      await getDoc(doc(db, 'posts', '1'));
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      code?: string;
      denialContext?: {
        rule?: {
          line?: number;
          col?: number;
          file?: string;
          citation?: string;
          expression?: string;
        };
      };
    };
    expect(err.code).toBe('permission-denied');
    expect(err.denialContext).toBeDefined();
    expect(err.denialContext!.rule).toBeDefined();
    expect(err.denialContext!.rule!.line).toBe(5);
    expect(err.denialContext!.rule!.col).toBe(7);
    expect(err.denialContext!.rule!.file).toBe('firestore.rules');
    expect(err.denialContext!.rule!.citation).toBe('firestore.rules:5:7');
  });

  it('unprovable-query denial carries clickable authored source line citation in DenialContext.rule', async () => {
    const rulesSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /posts/{id} {',
      '      allow read: if resource.data.visibility == "public";',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const sandbox = initializeSandbox({ auth: { uid: 'alice' } });
    setRules(sandbox, rulesSource);
    const db = getFirestore(sandbox);

    let caught: unknown;
    try {
      await getDocs(collection(db, 'posts'));
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      code?: string;
      denialContext?: {
        rule?: {
          line?: number;
          col?: number;
          file?: string;
          citation?: string;
          expression?: string;
        };
      };
    };
    expect(err.code).toBe('permission-denied');
    expect(err.denialContext).toBeDefined();
    expect(err.denialContext!.rule).toBeDefined();
    expect(err.denialContext!.rule!.line).toBe(5);
    expect(err.denialContext!.rule!.col).toBe(7);
    expect(err.denialContext!.rule!.file).toBe('firestore.rules');
    expect(err.denialContext!.rule!.citation).toBe('firestore.rules:5:7');
  });

  it('modular 2+modules resolved denial maps back to authored module file rather than intermediate text', async () => {
    const modularSource = [
      "rules_version = '2+modules';",
      "import { isAllowed } from './policy';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /items/{id} {',
      '      allow read: if isAllowed();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const resolved = resolveModulesBrowser(modularSource, {
      modules: {
        './policy': 'export function isAllowed() { return false; }',
      },
      sourceFile: 'firestore.modules.rules',
    } as unknown as Parameters<typeof resolveModulesBrowser>[1]);
    expect(resolved.success).toBe(true);
    let sourceToDeploy = '';
    const isSuccess = resolved.success === true;
    if (isSuccess) {
      const successData = (resolved as { success: true; data: { resolved: string } }).data;
      sourceToDeploy = successData.resolved;
    }

    const sandbox = initializeSandbox({ auth: { uid: 'alice' } });
    setRules(sandbox, sourceToDeploy);
    const db = getFirestore(sandbox);

    let caught: unknown;
    try {
      await getDoc(doc(db, 'items', '1'));
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      code?: string;
      denialContext?: {
        rule?: {
          line?: number;
          col?: number;
          file?: string;
          citation?: string;
          expression?: string;
        };
      };
    };
    expect(err.code).toBe('permission-denied');
    expect(err.denialContext).toBeDefined();
    expect(err.denialContext!.rule).toBeDefined();
    expect(err.denialContext!.rule!.line).toBe(6);
    expect(err.denialContext!.rule!.col).toBe(7);
    expect(err.denialContext!.rule!.file).toBe('firestore.modules.rules');
    expect(err.denialContext!.rule!.citation).toBe('firestore.modules.rules:6:7');
  });
});
