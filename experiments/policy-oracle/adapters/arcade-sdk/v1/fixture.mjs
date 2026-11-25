import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function materialize(fixture, caseId, { actor, reader, runId }) {
  const attempt = fixture.cases.find(({ id }) => id === caseId);
  assert.ok(attempt, 'unknown fixture case: ' + caseId);
  for (const segment of [actor, reader, runId]) assert.match(segment, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(actor, reader);
  const bindings = { actor, reader, match: `oracle-${runId}-${caseId}` };
  function bind(value) {
    if (typeof value === 'string') return value.replace(/\$(actor|reader|match)\b/g, (_, key) => bindings[key]);
    if (Array.isArray(value)) return value.map(bind);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bind(entry)]));
    return value;
  }
  return {
    caseId,
    actor,
    reader,
    operation: fixture.operation,
    path: bind(fixture.path),
    before: bind(fixture.before),
    data: bind(attempt.data),
    expected: attempt.expected,
    requestTime: fixture.requestTime,
  };
}

export function loadFixture(probe) {
  return JSON.parse(readFileSync(new URL('fixture.json', probe), 'utf8'));
}
