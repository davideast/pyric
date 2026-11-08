import { describe, expect, test } from 'bun:test';
import { isConcretePayload } from '../../../src/assurance-surface/probes/fixtures.js';

describe('isConcretePayload', () => {
  test('treats optional unknown fields as non-concrete while allowing optional determined kinds', () => {
    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'kind', kind: 'string', literal: 'note' },
          { name: 'url', kind: 'unknown', optional: true },
        ],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'kind', kind: 'string', literal: 'note' },
          { name: 'label', kind: 'string', optional: true },
        ],
      }),
    ).toBe(true);
  });

  test('treats childless object fields as non-concrete while accepting object fields with concrete subfields', () => {
    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [{ name: 'meta', kind: 'object' }],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'meta', kind: 'object' },
          { name: 'meta.tag', kind: 'string', optional: true },
        ],
      }),
    ).toBe(false);

    expect(
      isConcretePayload({
        kind: 'object',
        open: false,
        fields: [
          { name: 'meta', kind: 'object' },
          { name: 'meta.count', kind: 'number', literal: 1 },
        ],
      }),
    ).toBe(true);
  });
});
