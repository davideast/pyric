import { createHash } from 'node:crypto';
import { buildStorageApiTestCase, type StorageTestCase } from '../../pyric/src/rules/test/spec.ts';

export interface StorageScenarioInputDigest {
  algorithm: 'sha256';
  value: string;
}

/** Stable identity for any Storage Rules Test API microprobe. */
export function storageRulesTestInputDigest(
  rules: string,
  cases: readonly StorageTestCase[],
): StorageScenarioInputDigest {
  const testCases = cases.map((testCase) => {
    const { expectation: _expectation, ...productionInput } = buildStorageApiTestCase(testCase);
    return { description: testCase.description, input: productionInput };
  });
  const payload = {
    source: { files: [{ name: 'storage.rules', content: rules }] },
    testSuite: { testCases },
  };
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}
