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

test('code-form scope checks changed class methods in full without requiring edits to unchanged methods', () => {
  const before = `class Host {
    legacy() { if (count > 0) run(); }
    changed() { if (ready > 0) run(); return 1; }
  }`;
  const after = before.replace('return 1', 'return 2');
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' })).toEqual({
    issues: [{ rule: 'named-condition', line: 3, column: 21 }],
    excluded: [{ startLine: 2, endLine: 2, reason: 'unchanged-class-member' }],
  });
});

test('code-form scope checks new classes and changed class headers in full', () => {
  const before = 'class Host { legacy() { if (count > 0) run(); } }';
  const renamed = before.replace('class Host', 'class Replacement');
  const derived = before.replace('class Host', 'class Host extends Base');
  for (const after of [renamed, derived]) {
    expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' }).issues.map(issue => issue.rule))
      .toEqual(['named-condition']);
  }
  expect(checkChangedCodeForm({ after: before, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition']);
});

test('code-form scope checks changed constructors, properties, accessors, and static blocks', () => {
  const before = `class Host {
    value = condition ? 1 : 2;
    constructor() { if (count > 0) run(); }
    get ready() { if (count > 0) return true; return false; }
    static { if (count > 0) run(); }
  }`;
  const after = before.replace('condition ? 1', 'count > 0 ? 3').replaceAll('count > 0) ', 'count > 1) ');
  const result = checkChangedCodeForm({ before, after, fileName: 'input.ts' });
  expect(result.excluded).toEqual([]);
  expect(result.issues.map(issue => issue.rule)).toEqual(Array(4).fill('named-condition'));
});

test('code-form scope cannot hide duplicate members or new suppression comments', () => {
  const member = 'legacy() { if (count > 0) run(); }';
  const before = `class Host { ${member} }`;
  const duplicated = `class Host { ${member} ${member} }`;
  expect(checkChangedCodeForm({ before, after: duplicated, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition']);
  const suppressed = `class Host {\n// @ts-ignore\n${member}\nadded() {} }`;
  expect(checkChangedCodeForm({ before, after: suppressed, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['suppression']);
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

test('code-form scope checks changed factory logic without pulling unchanged nested callbacks into scope', () => {
  const before = `export function factory() {
    const legacy = () => { if (old > 0) run(); };
    const changed = () => { if (old > 0) run(); };
    return { legacy, changed };
  }`;
  const after = before.replace('const changed = () => { if (old > 0)', 'const changed = () => { if (old > 1)');
  const result = checkChangedCodeForm({ before, after, fileName: 'input.ts' });
  expect(result.issues.map(issue => issue.rule)).toEqual(['named-condition']);
  expect(result.excluded.some(range => range.reason === 'unchanged-nested-function')).toBe(true);
});

test('factory exclusions cannot hide changed guards, new duplicate callbacks or suppressions', () => {
  const before = 'function factory() { const callback = () => { if (old > 0) run(); }; return callback; }';
  const after = before.replace('return callback;', 'const added = () => { if (old > 0) run(); }; if (ready > 0) run(); return callback;');
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition', 'named-condition']);
  const suppressed = before.replace('const callback', '\n// @ts-ignore\nconst callback').replace('return callback;', 'return [callback];');
  expect(checkChangedCodeForm({ before, after: suppressed, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['suppression']);
});


test('factory scope does not borrow legacy callbacks from another factory', () => {
  const before = 'function original() { const callback = () => { if (old > 0) run(); }; }';
  const after = before.replace('original', 'different');
  expect(checkChangedCodeForm({ before, after, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition']);
});

test('changing a factory signature or class header rechecks its nested callbacks', () => {
  const factory = 'function factory(old: number) { const callback = () => { if (old > 0) run(); }; }';
  const factoryChanged = factory.replace('old: number', 'old: string');
  expect(checkChangedCodeForm({ before: factory, after: factoryChanged, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition']);
  const originalClass = 'class Host { method() { const callback = () => { if (old > 0) run(); }; } }';
  const classChanged = originalClass.replace('class Host', 'class Host extends Base');
  expect(checkChangedCodeForm({ before: originalClass, after: classChanged, fileName: 'input.ts' }).issues.map(issue => issue.rule))
    .toEqual(['named-condition']);
});
