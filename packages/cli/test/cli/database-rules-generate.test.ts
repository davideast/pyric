import { describe, expect, it } from 'bun:test';
import { runDatabaseRulesGenerate } from '../../src/cli/database-rules.js';
import type { ParsedArgs } from '../../src/cli/parse-args.js';

function run(rules: unknown) {
  let stdout = '';
  let stderr = '';
  let written: string | undefined;
  const args = { positional: [], flags: new Map([['out', 'out.json']]) } as unknown as ParsedArgs;
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
});
