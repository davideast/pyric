import { describe, expect, test } from 'bun:test';
import { rtdbStdlib } from 'pyric/rules';
import { RTDB_STDLIB_MODULES } from '../../../../src/rules/rtdb/stdlib/catalog.js';
import { buildRuleExpression } from '../../../../src/rules/rtdb/compiled-rules.js';
import { createFirestoreRulesStdlibTools } from '../../../../src/rules/stdlib-tools.js';

const tool = (name: string) => {
  const found = createFirestoreRulesStdlibTools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return (args: Record<string, unknown>) => found.execute(args, {} as never) as Promise<{ ok: boolean; summary: string; data: any }>;
};

describe('RTDB stdlib catalog', () => {
  test('lists every module on rtdbStdlib and nothing else', () => {
    expect(RTDB_STDLIB_MODULES.map((m) => m.key).sort()).toEqual(Object.keys(rtdbStdlib).sort());
  });

  for (const module of RTDB_STDLIB_MODULES) {
    test(`${module.key}: one entry per export`, () => {
      const exported = Object.keys(rtdbStdlib[module.key]).sort();
      expect(module.entries.map((e) => e.name).sort()).toEqual(exported);
    });

    test(`${module.key}: every expression output parses as a rule`, () => {
      for (const entry of module.entries) {
        if (typeof entry.output !== 'string') continue;
        const parsed = buildRuleExpression(entry.output, 'write', ['$matchId']);
        expect({ name: entry.name, errors: parsed.parsed.errors }).toEqual({ name: entry.name, errors: [] });
        expect(entry.length).toBe(entry.output.length);
      }
    });
  }
});

describe('rules_stdlib_list and rules_stdlib_get for database', () => {
  test('list returns the RTDB modules with placement per function', async () => {
    const listed = await tool('rules_stdlib_list')({ service: 'database' });
    expect(listed.ok).toBe(true);
    expect(listed.data.modules.map((m: { key: string }) => m.key)).toEqual(RTDB_STDLIB_MODULES.map((m) => m.key));
    const lobby = listed.data.modules.find((m: { key: string }) => m.key === 'lobby');
    expect(lobby.functions.find((f: { name: string }) => f.name === 'validCreate').placement).toBe('match node .write');
  });

  test('the firestore and storage listings do not include the RTDB modules', async () => {
    const listed = await tool('rules_stdlib_list')({ service: 'firestore' });
    expect(listed.data.modules.some((m: { kind: string }) => m.kind === 'rtdb-builders')).toBe(false);
  });

  test('get returns a module with its import line and compiled examples', async () => {
    const got = await tool('rules_stdlib_get')({ service: 'database', key: 'Turns' });
    expect(got.ok).toBe(true);
    expect(got.data.importLine).toBe("import { rtdbStdlib } from 'pyric/rules'; const { turns } = rtdbStdlib;");
    expect(got.data.module.entries.find((e: { name: string }) => e.name === 'isMyTurn').output).toBe(rtdbStdlib.turns.isMyTurn());
  });

  test('get names a Firestore-only module as incompatible and suggests a close key', async () => {
    const fairness = await tool('rules_stdlib_get')({ service: 'database', key: 'fairness' });
    expect(fairness.ok).toBe(false);
    expect(fairness.summary).toContain('not compatible with database');
    const typo = await tool('rules_stdlib_get')({ service: 'database', key: 'counter' });
    expect(typo.data.suggestion).toBe('counters');
  });
});
