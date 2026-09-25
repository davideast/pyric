import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';

describe('parseArgs boolean flags', () => {
  it('does not consume following positional arguments for valueless CLI and surface boolean flags', () => {
    const booleanFlags = [
      'include-passwords',
      'excludePasswords',
      'stdin',
      'confirm',
      'disabled',
      'emailVerified',
    ] as const;

    for (const flag of booleanFlags) {
      const parsed = parseArgs(['auth', `--${flag}`, 'target-positional']);
      expect(parsed.subcommand).toBe('auth');
      expect(parsed.flags.get(flag)).toBe(true);
      expect(parsed.positional).toEqual(['target-positional']);
    }
  });
});
