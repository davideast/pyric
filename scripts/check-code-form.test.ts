import { expect, test } from 'bun:test';
import { checkCodeForm, checkChangedCodeForm } from './check-code-form.js';

test('code-form gate rejects inline branch decisions and accepts named decisions', () => {
  expect(checkCodeForm('const isReady = count > 0; if (isReady) start();')).toEqual([]);
  expect(checkCodeForm('if (count > 0) start();')).toEqual([
    { rule: 'named-condition', line: 1, column: 5 },
  ]);
});

test('code-form gate rejects type escapes and suppressions without flagging strings or const assertions', () => {
  expect(checkCodeForm(`
    const label = '@ts-ignore';
    const value = { kind: 'ready' } as const;
  `)).toEqual([]);
  expect(checkCodeForm(`
    const value: any = input;
    const converted = (input as unknown) as Result;
    const required = input!;
    // @ts-expect-error hidden mismatch
    run(input);
  `).map((issue) => issue.rule)).toEqual([
    'explicit-any', 'double-assertion', 'non-null-assertion', 'suppression',
  ]);
});

test('code-form gate rejects hidden branching in nested choices, spreads, and side effects', () => {
  expect(checkCodeForm(`
    const label = isReady ? 'ready' : 'waiting';
    const copy = { ...record };
    if (isReady) run();
  `)).toEqual([]);
  expect(checkCodeForm(`
    const label = isReady ? 'ready' : (isPending ? 'pending' : 'waiting');
    const copy = { ...(isReady && record) };
    isReady && run();
  `).map((issue) => issue.rule)).toEqual([
    'nested-ternary', 'conditional-spread', 'logical-side-effect',
  ]);
});

test('code-form gate applies named decisions to loops, choices, and JSX rendering', () => {
  const named = `
    while (hasWork) run();
    do run(); while (hasWork);
    for (; hasWork;) run();
    const label = isReady ? 'ready' : 'waiting';
    const view = <div>{isReady && <span />}</div>;
  `;
  expect(checkCodeForm(named)).toEqual([]);
  const inline = `
    while (count > 0) run();
    do run(); while (count > 0);
    for (; count > 0;) run();
    const label = count > 0 ? 'ready' : 'waiting';
    const view = <div>{count > 0 && <span />}</div>;
  `;
  expect(checkCodeForm(inline).map((issue) => issue.rule)).toEqual([
    'named-condition', 'named-condition', 'named-condition', 'named-condition', 'named-condition',
  ]);
});

test('code-form gate refuses malformed source instead of reporting a clean file', () => {
  expect(checkCodeForm('const ready = ;')).toEqual([
    { rule: 'syntax', line: 1, column: 15 },
  ]);
  expect(checkCodeForm('const ready = true;')).toEqual([]);
});

test('code-form gate parses TypeScript assertions and generics using the source filename', () => {
  expect(checkCodeForm('const identity = <T>(value: T) => value;', 'input.ts')).toEqual([]);
  expect(checkCodeForm('const value = <Result><unknown>input;', 'input.ts').map((issue) => issue.rule)).toEqual([
    'double-assertion',
  ]);
  expect(checkCodeForm('const view = <div>{isReady && <span />}</div>;', 'input.tsx')).toEqual([]);
});

test('code-form gate reports unchanged declarations excluded from a changed file', () => {
  const before = 'function legacy() { if (count > 0) run(); }';
  const after = `${before}\nfunction added() { if (ready > 0) run(); }`;
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' })).toEqual({
    issues: [{ rule: 'named-condition', line: 2, column: 24 }],
    excluded: [{ startLine: 1, endLine: 1, reason: 'unchanged-top-level-statement' }],
  });
});

test('code-form scope retains old violations inside a modified function', () => {
  const before = 'function legacy() { if (count > 0) run(); return 1; }';
  const after = 'function legacy() { if (count > 0) run(); return 2; }';
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' })).toEqual({
    issues: [{ rule: 'named-condition', line: 1, column: 25 }],
    excluded: [],
  });
});

test('code-form scope checks new files and additions sharing a line with unchanged code', () => {
  const before = 'const value = 1;';
  const after = `${before} if (value > 0) run();`;
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' }).issues).toEqual([
    { rule: 'named-condition', line: 1, column: 22 },
  ]);
  expect(checkChangedCodeForm({ after: 'if (value > 0) run();', fileName: 'input.ts' })).toEqual({
    issues: [{ rule: 'named-condition', line: 1, column: 5 }],
    excluded: [],
  });
});

test('code-form scope refuses new suppressions before unchanged declarations', () => {
  const before = 'const value = 1;';
  const after = `// @ts-ignore\n${before}`;
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' }).issues).toEqual([
    { rule: 'suppression', line: 1, column: 1 },
  ]);
});

test('code-form gate checks declarations without trying to emit JavaScript', () => {
  expect(() => checkCodeForm('export declare const ready: boolean;', 'input.d.ts')).not.toThrow();
  expect(checkCodeForm('export declare const ready: boolean;', 'input.d.ts')).toEqual([]);
  expect(checkCodeForm('export declare const value: any;', 'input.d.ts')).toEqual([
    { rule: 'explicit-any', line: 1, column: 29 },
  ]);
});

test('code-form gate distinguishes template contents from suppression comments', () => {
  const source = 'const first = `${value}`;\nconst text = `// @ts-ignore\\n${value}`;';
  expect(checkCodeForm(source, 'input.ts')).toEqual([]);
});
