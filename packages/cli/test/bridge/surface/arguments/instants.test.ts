/**
 * The one refusal both instant-bearing arguments share.
 *
 * The message is the product: an agent that named the wrong shape reads it and
 * corrects itself, so these assert whole messages rather than a substring, and
 * they assert that the field's own name appears in both halves.
 */
import { describe, expect, it } from 'bun:test';

import { checkInstant } from '../../../../src/bridge/surface/arguments/instants.js';
import type { InvalidArguments } from '../../../../src/bridge/surface/method-types.js';

/** The `fail` a validator is handed, recording what it was told. */
function recordingFail(body: string, fix: string, field?: string): InvalidArguments {
  return { kind: 'invalid-arguments', body, fix, field } as unknown as InvalidArguments;
}

describe('refusing an argument that is meant to be an instant', () => {
  it('accepts an ISO 8601 instant', () => {
    expect(checkInstant('isoTime', { isoTime: '2026-09-09T12:00:00.000Z' }, recordingFail))
      .toBeNull();
  });

  it('accepts an absent value, leaving requiredness to the schema', () => {
    expect(checkInstant('requestTime', {}, recordingFail)).toBeNull();
  });

  it('names the field, the value, and the accepted form', () => {
    const refusal = checkInstant('isoTime', { isoTime: 'next tuesday' }, recordingFail);

    expect(refusal).toEqual({
      kind: 'invalid-arguments',
      body: `isoTime is 'next tuesday', which does not parse as a date.`,
      fix: `Pass isoTime as an ISO 8601 string, such as '2026-09-09T12:00:00.000Z'.`,
      field: 'isoTime',
    } as unknown as InvalidArguments);
  });

  it('refuses a value that is not a string at all', () => {
    const refusal = checkInstant('requestTime', { requestTime: 17 }, recordingFail);

    expect(refusal).toMatchObject({
      body: `requestTime is '17', which does not parse as a date.`,
      field: 'requestTime',
    });
  });
});
