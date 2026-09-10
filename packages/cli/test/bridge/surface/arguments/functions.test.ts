/** The `functions` tool's argument vocabulary. */
import { describe, expect, it } from 'bun:test';

import {
  pathArgument,
  triggerArgument,
  valueArgument,
} from '../../../../src/bridge/surface/arguments/functions.js';

describe('triggerArgument and pathArgument', () => {
  it('require a string', () => {
    expect(triggerArgument.safeParse('makeUppercase').success).toBe(true);
    expect(triggerArgument.safeParse(1).success).toBe(false);
    expect(pathArgument.safeParse('messages/abc123/original').success).toBe(true);
    expect(pathArgument.safeParse(1).success).toBe(false);
  });
});

describe('valueArgument', () => {
  it('accepts any JSON-shaped value, string or otherwise', () => {
    expect(valueArgument.safeParse('hello').success).toBe(true);
    expect(valueArgument.safeParse({ nested: true }).success).toBe(true);
    expect(valueArgument.safeParse(null).success).toBe(true);
  });
});
