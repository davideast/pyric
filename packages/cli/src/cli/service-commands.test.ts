import { describe, expect, it } from 'bun:test';

import { parseArgs } from './parse-args.js';
import {
  createServiceCommandRegistry,
  dispatchServiceCommand,
} from './service-commands.js';

describe('service command dispatcher', () => {
  it('leaves non-service commands for the top-level dispatcher', async () => {
    expect(await dispatchServiceCommand(parseArgs(['dev']))).toBeNull();
  });

  it('rejects an unknown command beneath a known service with the complete invocation', async () => {
    let stderr = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(
        await dispatchServiceCommand(parseArgs(['firestore', 'rules', 'unknown', 'operand'])),
      ).toBe(1);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderr).toBe("pyric: unknown command 'firestore rules unknown operand'.\n");
  });

  it('rejects duplicate route paths when constructing a registry', () => {
    const run = async (): Promise<number> => 0;

    expect(() =>
      createServiceCommandRegistry([
        { path: ['firestore', 'rules', 'lint'], run },
        { path: ['firestore', 'rules', 'lint'], run },
      ]),
    ).toThrow("duplicate service command 'firestore rules lint'");
  });
});
