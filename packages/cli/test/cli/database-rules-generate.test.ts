import { describe, expect, it } from 'bun:test';
import { runDatabaseRulesGenerate } from '../../src/cli/database-rules.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

function run(rules: unknown, extraFlags: Array<[string, string | boolean]> = []) {
  let stdout = '';
  let stderr = '';
  let written: string | undefined;
  const args = {
    positional: [],
    flags: new Map<string, string | boolean>([['out', 'out.json'], ...extraFlags]),
  } as unknown as ParsedArgs;
  const code = runDatabaseRulesGenerate(args, {
    stdout: { write: (text: string) => ((stdout += text), true) } as NodeJS.WriteStream,
    stderr: { write: (text: string) => ((stderr += text), true) } as NodeJS.WriteStream,
    cwd: '/project',
    loadRulesDocument: async () => ({ ok: true, document: { toJSON: () => rules } as never }),
    mkdir: (async () => undefined) as never,
    writeFile: (async (_path: string, data: string) => {
      written = data;
    }) as never,
  });
  return code.then((exit) => ({ exit, stdout, stderr, written }));
}

describe('database rules generate', () => {
  it('writes rules production would load', async () => {
    const result = await run({ rules: { '.read': 'auth != null' } });
    expect(result.exit).toBe(0);
    expect(result.written).toContain('"rules"');
  });

  it('writes nothing and names the reason when production would refuse the generated rules', async () => {
    const result = await run({ rules: { a: { $x: {}, $y: {} } } });
    expect(result.exit).toBe(2);
    expect(result.written).toBeUndefined();
    expect(result.stderr).toContain("Cannot have multiple default rules ('$x' and '$y').");
  });

  it('exits 0 by default without --fail-on even when RTDB-SEC-1 is present', async () => {
    const result = await run({ rules: { '.read': true, '.write': true } });
    expect(result.exit).toBe(0);
    expect(result.written).toContain('"rules"');
  });

  it('exits 2 and writes nothing when --fail-on high or --fail-on critical is met by RTDB-SEC-1', async () => {
    for (const level of ['high', 'critical'] as const) {
      const result = await run({ rules: { '.read': true, '.write': true } }, [['fail-on', level]]);
      expect(result.exit).toBe(2);
      expect(result.written).toBeUndefined();
      expect(result.stderr).toContain('RTDB-SEC-1');
      expect(result.stderr).toContain('critical');
      expect(result.stderr).toContain('.write');
    }
  });

  it('exits 0 with --fail-on high on a medium-only finding (RTDB-SEC-2 on /posts) and exits 2 with --fail-on medium', async () => {
    const mediumRules = { rules: { posts: { '.read': true } } };
    const highResult = await run(mediumRules, [['fail-on', 'high']]);
    expect(highResult.exit).toBe(0);
    expect(highResult.written).toContain('"posts"');

    const mediumResult = await run(mediumRules, [['fail-on', 'medium']]);
    expect(mediumResult.exit).toBe(2);
    expect(mediumResult.written).toBeUndefined();
    expect(mediumResult.stderr).toContain('RTDB-SEC-2');
    expect(mediumResult.stderr).toContain('medium');
    expect(mediumResult.stderr).toContain('/posts');
    expect(mediumResult.stderr).toContain('.read');
  });

  it('exits 1 and writes nothing when --fail-on is given an invalid value', async () => {
    const result = await run({ rules: {} }, [['fail-on', 'bogus']]);
    expect(result.exit).toBe(1);
    expect(result.written).toBeUndefined();
    expect(result.stderr).toContain('Invalid --fail-on level "bogus". Expected critical, high, or medium.');
  });
});
