import { expect, test } from 'bun:test';
import { RULES_BUILTIN_FUNCTIONS } from '../../src/grammar/builtin-functions.js';

test('owns the bare-call Rules builtin registry', () => {
  expect([...RULES_BUILTIN_FUNCTIONS]).toEqual(['get', 'exists', 'getAfter', 'debug']);
});
