/**
 * The rules engine records are the one declaration of which services carry
 * Security Rules.
 *
 * The service set used to be spelled four times: as a list in the argument
 * vocabulary, as the keys of a request-method table beside it, as an `if` chain
 * that picked a parser, and as the engine record set itself. Each of those was
 * a file every new service had to edit. The record set is now the declaration,
 * and everything else reads it, which this file pins.
 */
import { describe, expect, it } from 'bun:test';

import { RULES_SERVICES, rulesEngineFor } from '../../../../src/bridge/surface/rules-engines/registry.js';
import { SERVICES } from '../../../../src/bridge/surface/arguments/rules.js';

describe('the engine records declare the services', () => {
  it('names the three services that carry Security Rules', () => {
    expect([...RULES_SERVICES]).toEqual(['firestore', 'database', 'storage']);
  });

  it('derives the argument vocabulary from the record names', () => {
    expect([...SERVICES]).toEqual([...RULES_SERVICES]);
  });

  it('carries every service its own request methods', () => {
    for (const service of RULES_SERVICES) {
      expect(rulesEngineFor(service).requestMethods.length).toBeGreaterThan(0);
    }
    expect([...rulesEngineFor('database').requestMethods]).toEqual(['read', 'write', 'validate']);
  });

  it('carries every service its own source check', () => {
    expect(rulesEngineFor('database').parseFailure('{"rules": {}}')).toBeNull();
    const database = rulesEngineFor('database').parseFailure('not json');
    expect(database?.body).toContain('JSON');
    expect(database?.fix.startsWith('Pass')).toBe(true);

    const firestore = rulesEngineFor('firestore').parseFailure('not rules at all {');
    expect(firestore?.body).toContain('did not parse');
    const storage = rulesEngineFor('storage').parseFailure('not rules at all {');
    expect(storage?.body).toContain('did not parse');
  });
});
