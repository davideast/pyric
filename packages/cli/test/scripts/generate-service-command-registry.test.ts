import { describe, expect, it } from 'bun:test';
import {
  parseServiceCommandRecord,
  renderServiceCommandRegistry,
} from '../../scripts/generate-service-command-registry.ts';

describe('service-command registry generation', () => {
  it('derives the route exclusively from the record filename', () => {
    expect(parseServiceCommandRecord('firestore-rules-lint.ts')).toEqual({
      file: 'firestore-rules-lint.ts',
      identifier: 'firestoreRulesLint',
      path: ['firestore', 'rules', 'lint'],
    });
  });

  it('renders static imports so standalone compilation embeds every handler', () => {
    const source = renderServiceCommandRegistry(['firestore-rules-lint.ts']);
    expect(source).toContain(
      "import firestoreRulesLint from './service-command-records/firestore-rules-lint.js';",
    );
    expect(source).toContain(
      '{ path: ["firestore","rules","lint"], run: firestoreRulesLint },',
    );
    expect(source).toContain('satisfies readonly ServiceCommand[]');
    expect(source).not.toContain('readdirSync');
  });

  it('derives a two-word route when the subject is the service itself', () => {
    expect(parseServiceCommandRecord('auth-impersonate.ts')).toEqual({
      file: 'auth-impersonate.ts',
      identifier: 'authImpersonate',
      path: ['auth', 'impersonate'],
    });
    expect(renderServiceCommandRegistry(['auth-impersonate.ts'])).toContain(
      '{ path: ["auth","impersonate"], run: authImpersonate },',
    );
  });

  it('rejects filenames that cannot be one unambiguous route', () => {
    expect(() => parseServiceCommandRecord('firestore.ts')).toThrow(
      'expected <service>-<artifact>-<operation>.ts or <service>-<operation>.ts',
    );
    expect(() => parseServiceCommandRecord('firestore-rules-lint-extra.ts')).toThrow(
      'expected <service>-<artifact>-<operation>.ts or <service>-<operation>.ts',
    );
  });
});
