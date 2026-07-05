/** Guards the JSON-Schema -> Zod converter against the `oneOf` regression:
 *  the `as` arg (`'admin' | { uid, claims? }`) is expressed with `oneOf`, and a
 *  missing oneOf branch silently degraded it to `z.any()` — advertising an
 *  unconstrained arg to the agent (worse than the old typed schema). */
import { describe, it, expect } from 'bun:test';
import { jsonSchemaToZodShape } from '../../src/bridge/server/json-schema-to-zod.js';

// The shape of AS_SCHEMA in packages/pyric/src/firestore/tools.ts.
const AS_SCHEMA = {
  oneOf: [
    { type: 'string', enum: ['admin'] },
    {
      type: 'object',
      properties: { uid: { type: 'string' }, claims: { type: 'object' } },
      required: ['uid'],
    },
  ],
};

describe('jsonSchemaToZodShape — oneOf (the `as` arg)', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    properties: { as: AS_SCHEMA },
    required: [],
  });

  it('accepts the two valid shapes', () => {
    expect(shape.as.safeParse('admin').success).toBe(true);
    expect(shape.as.safeParse({ uid: 'alice' }).success).toBe(true);
    expect(shape.as.safeParse(undefined).success).toBe(true); // optional
  });

  it('REJECTS garbage — proving it is a union, not z.any()', () => {
    // z.any() (the regression) would have accepted all of these.
    expect(shape.as.safeParse('root').success).toBe(false);
    expect(shape.as.safeParse({ no_uid: true }).success).toBe(false);
    expect(shape.as.safeParse(42).success).toBe(false);
  });
});
