import { describe, expect, test } from 'bun:test';
import {
  evidenceForRulesModule,
  servicesForRulesModule,
} from '../../scripts/stdlib-service-contract.js';

describe('stdlib service declarations', () => {
  test('parses supported service declarations', () => {
    expect(servicesForRulesModule('common.rules', '// @pyric-services cloud.firestore,firebase.storage\n'))
      .toEqual(['cloud.firestore', 'firebase.storage']);
  });

  test('rejects missing, unknown, or duplicate declarations', () => {
    expect(() => servicesForRulesModule('missing.rules', 'export function x() {}'))
      .toThrow('first line must declare');
    expect(() => servicesForRulesModule('unknown.rules', '// @pyric-services other\n'))
      .toThrow('invalid @pyric-services');
    expect(() => servicesForRulesModule(
      'duplicate.rules',
      '// @pyric-services firebase.storage,firebase.storage\n',
    )).toThrow('invalid @pyric-services');
  });

  test('parses optional module-owned evidence declarations', () => {
    expect(evidenceForRulesModule(
      'common.rules',
      '// @pyric-services cloud.firestore,firebase.storage\n// @pyric-evidence storage-rules#125\n',
    )).toEqual(['storage-rules#125']);
    expect(evidenceForRulesModule(
      'unproven.rules',
      '// @pyric-services firebase.storage\nexport function x() { return true; }\n',
    )).toEqual([]);
    expect(() => evidenceForRulesModule(
      'invalid.rules',
      '// @pyric-services firebase.storage\n// @pyric-evidence not-a-row\n',
    )).toThrow('invalid @pyric-evidence');
  });
});
