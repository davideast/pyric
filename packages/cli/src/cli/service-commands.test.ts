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

  it('leaves an unmatched route to the top-level dispatcher', async () => {
    expect(
      await dispatchServiceCommand(parseArgs(['firestore', 'rules', 'unknown', 'operand'])),
    ).toBeNull();
  });

  it('routes a derived method command to its record', async () => {
    expect(await dispatchServiceCommand(parseArgs(['auth', 'whoami']))).toBe(0);
  });

  it('leaves a service word that is also a command of its own alone', async () => {
    expect(await dispatchServiceCommand(parseArgs(['sandbox', 'npm', 'run', 'dev']))).toBeNull();
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
