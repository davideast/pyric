/**
 * The `rules` tool's argument vocabulary: the service and operation enums
 * derived from the rules-engine records, and the two checks a schema cannot
 * state, that the operation belongs to the named service and that the
 * source parses for it.
 */
import { describe, expect, it } from 'bun:test';

import {
  checkOperation,
  checkRulesParse,
  operation,
  RENAMES,
  REQUEST_METHODS,
  requestMethodOf,
  requestMethodsOf,
  service,
  SERVICES,
} from '../../../../src/bridge/surface/arguments/rules.js';
import { RULES_SERVICES, rulesEngineFor } from '../../../../src/bridge/surface/rules-engines/registry.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('rules', 'simulate');

describe('the renames', () => {
  it('maps neighbouring spellings onto the record shape', () => {
    expect(RENAMES.product).toBe('service');
    expect(RENAMES.source).toBe('rules');
    expect(RENAMES.rulesSource).toBe('rules');
    expect(RENAMES.method).toBe('operation');
    expect(RENAMES.op).toBe('operation');
  });
});

describe('the service and operation vocabularies', () => {
  it('reads the service set from the rules-engine records', () => {
    expect([...SERVICES]).toEqual([...RULES_SERVICES]);
  });

  it('accepts only a known service', () => {
    expect(service.safeParse('firestore').success).toBe(true);
    expect(service.safeParse('spanner').success).toBe(false);
  });

  it('unions every service its own request methods into REQUEST_METHODS', () => {
    for (const name of SERVICES) {
      for (const method of requestMethodsOf(name)) {
        expect(REQUEST_METHODS).toContain(method);
      }
    }
  });

  it('accepts only a known request method', () => {
    expect(operation.safeParse(REQUEST_METHODS[0]).success).toBe(true);
    expect(operation.safeParse('teleport').success).toBe(false);
  });

  it('narrows the operation schema to one service own methods', () => {
    const narrowed = requestMethodOf('database');
    expect(narrowed.safeParse('read').success).toBe(true);
    expect(narrowed.safeParse('get').success).toBe(false);
  });
});

describe('checkOperation', () => {
  it('rejects a request method the named service does not evaluate', () => {
    const rejection = checkOperation({ service: 'database', operation: 'get' }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('operation');
    expect(rejection?.summary).toContain('database');
  });

  it('passes a request method the named service does evaluate', () => {
    expect(checkOperation({ service: 'database', operation: 'read' }, fail)).toBeNull();
  });
});

describe('checkRulesParse', () => {
  it('rejects a rules source that does not parse for the named service', () => {
    const rejection = checkRulesParse({ service: 'firestore', rules: 'not rules at all {' }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('rules');
  });

  it('passes when the engine reports no parse problem', () => {
    expect(checkRulesParse({ service: 'database', rules: '{"rules": {}}' }, fail)).toBeNull();
  });
});

describe('rulesEngineFor stays the one source of the service and method lists', () => {
  it('is what SERVICES and REQUEST_METHODS were built from', () => {
    for (const name of SERVICES) {
      expect(rulesEngineFor(name).requestMethods.length).toBeGreaterThan(0);
    }
  });
});
