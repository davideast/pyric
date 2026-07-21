import { describe, expect, test } from 'bun:test';
import { servicesForRulesModule } from '../../scripts/stdlib-service-contract.js';

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
});
