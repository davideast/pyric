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
  it('accepts ISO 8601 instants with Z or an explicit offset', () => {
    for (const valid of [
      '2026-09-09T12:00:00Z',
      '2026-09-09T12:00:00.000Z',
      '2026-09-09T12:00:00.123456789Z',
      '2026-09-09T12:00:00+02:00',
      '2026-09-09T12:00:00-07:30',
      '2024-02-29T23:59:59Z',
    ]) {
      expect(checkInstant('isoTime', { isoTime: valid }, recordingFail)).toBeNull();
    }
  });

  it('accepts an absent value, leaving requiredness to the schema', () => {
    expect(checkInstant('requestTime', {}, recordingFail)).toBeNull();
  });

  it('names the field, the value, and the accepted form', () => {
    const refusal = checkInstant('isoTime', { isoTime: 'next tuesday' }, recordingFail);

    expect(refusal).toEqual({
      kind: 'invalid-arguments',
      body: `isoTime is 'next tuesday', which is not an ISO 8601 instant with Z or an explicit timezone offset.`,
      fix: `Pass isoTime as an ISO 8601 instant with Z or an explicit offset, such as '2026-09-09T12:00:00.000Z'.`,
      field: 'isoTime',
    } as unknown as InvalidArguments);
  });

  it('refuses Date.parse quirks and host-timezone-naive strings (#1920)', () => {
    for (const rejected of [
      '1',
      'March 7',
      '2026-09-09',
      '2026-09-09 12:00',
      '2026-09-09T12:00',
      '2026-09-09T12:00:00',
      '2026-09-09T12:00:00.000',
      '2026-02-29T12:00:00Z',
      '2026-02-30T12:00:00Z',
      '2026-09-09T24:00:00Z',
      '2026-09-09T12:00:00+24:00',
      '2026-09-09T12:00:00+02:60',
    ]) {
      const refusal = checkInstant('requestTime', { requestTime: rejected }, recordingFail);
      expect(refusal).toEqual({
        kind: 'invalid-arguments',
        body: `requestTime is '${rejected}', which is not an ISO 8601 instant with Z or an explicit timezone offset.`,
        fix: `Pass requestTime as an ISO 8601 instant with Z or an explicit offset, such as '2026-09-09T12:00:00.000Z'.`,
        field: 'requestTime',
      } as unknown as InvalidArguments);
    }
  });

  it('refuses a value that is not a string at all', () => {
    const refusal = checkInstant('requestTime', { requestTime: 17 }, recordingFail);

    expect(refusal).toMatchObject({
      body: `requestTime is '17', which is not an ISO 8601 instant with Z or an explicit timezone offset.`,
      field: 'requestTime',
    });
  });

  it('refuses ISO instants outside years 0001..9999', () => {
    for (const outOfRange of [
      '0000-01-01T00:00:00.000Z',
      '0001-01-01T00:00:00+02:00',
      '9999-12-31T23:59:59-02:00',
      '+020000-01-01T00:00:00.000Z',
    ]) {
      const refusal = checkInstant('isoTime', { isoTime: outOfRange }, recordingFail);
      expect(refusal).toMatchObject({
        body: `isoTime is '${outOfRange}', which falls outside the supported timestamp range (0001-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z).`,
        field: 'isoTime',
      });
    }
  });
});
