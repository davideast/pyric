import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModulesBrowser } from '../../src/rules/modules/resolver-browser.ts';
import { parseStorageRules, type StorageAuth, type StorageResource } from '../../src/storage/sandbox/rules.ts';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.ts';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', 'src', 'rules', 'modules', 'stdlib', 'storage');

interface StorageStdlibCase {
  description: string;
  expectation: 'ALLOW' | 'DENY';
  method: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth?: StorageAuth | null;
  resource?: { size: number; contentType?: string; metadata?: Record<string, string> };
  existingResource?: StorageResource | null;
  requestTime?: string;
  wrapFunction: string;
  wrapCallExpr?: string;
}

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((file) => file.endsWith('.test.json')).sort();

it('discovers every shipped Storage stdlib module fixture', () => {
  expect(fixtureFiles).toEqual(['metadata.test.json', 'objects.test.json', 'time.test.json', 'uploads.test.json']);
});

for (const file of fixtureFiles) {
  const moduleName = `storage/${file.replace(/\.test\.json$/, '')}`;
  const cases = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as StorageStdlibCase[];
  describe(`Storage stdlib semantics: ${moduleName}`, () => {
    for (const testCase of cases) {
      it(testCase.description, () => {
        const source = `rules_version = '2+modules';
import { ${testCase.wrapFunction} } from '${moduleName}';
service firebase.storage {
  match /b/{bucket}/o {
    match /test/{file} {
      allow ${testCase.method}: if ${testCase.wrapCallExpr ?? `${testCase.wrapFunction}()`};
    }
  }
}`;
        const resolved = resolveModulesBrowser(source);
        if (!resolved.success) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
        const result = evaluateStorageRules(
          parseStorageRules(resolved.data.resolved),
          {
            request: {
              auth: testCase.auth ?? null,
              method: testCase.method,
              path: `b/test/o/${testCase.path}`,
              ...(testCase.resource ? { resource: testCase.resource } : {}),
            },
            resource: testCase.existingResource ?? null,
          },
          testCase.requestTime ? new Date(testCase.requestTime) : new Date('2026-07-21T00:00:00Z'),
        );
        expect(result.allowed).toBe(testCase.expectation === 'ALLOW');
      });
    }
  });
}
