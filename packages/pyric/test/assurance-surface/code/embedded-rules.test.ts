import { describe, expect, test } from 'bun:test';
import { findEmbeddedRules } from '../../../src/assurance-surface/code/embedded-rules.js';
import { harness, ROOT } from './harness.js';

describe('findEmbeddedRules', () => {
  test('rules installed into the in-page sandbox, as a template string and an object', () => {
    const h = harness({
      'driver.ts': `
        import { setRules as setFs } from 'pyric/sandbox/firestore';
        import { setRules as setDb } from 'pyric/sandbox/database';
        import { setRules as setSt } from 'pyric/sandbox/storage';
        export function init(sandbox: any) {
          const fsRules = \`rules_version = '2';\`;
          setFs(sandbox, fsRules);
          const dbRules = { rules: { presence: { $uid: { '.write': 'auth.uid === $uid' } } } };
          setDb(sandbox, dbRules);
          setSt(sandbox, 'service firebase.storage {}');
        }
      `,
    });
    expect(findEmbeddedRules(h.ev, [h.file('driver.ts')], ROOT)).toEqual([
      { service: 'firestore', source: 'driver.ts:7', rules: "rules_version = '2';" },
      { service: 'rtdb', source: 'driver.ts:9', rules: { rules: { presence: { $uid: { '.write': 'auth.uid === $uid' } } } } },
      { service: 'storage', source: 'driver.ts:10', rules: 'service firebase.storage {}' },
    ]);
  });

  test('rules given to the rules unit-testing library', () => {
    const h = harness({
      't.ts': `
        import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
        const RULES = 'service cloud.firestore {}';
        initializeTestEnvironment({ projectId: 'p', firestore: { rules: RULES }, database: { rules: '{"rules":{}}' } });
      `,
    });
    expect(findEmbeddedRules(h.ev, [h.file('t.ts')], ROOT).map((r) => [r.service, r.rules])).toEqual([
      ['firestore', 'service cloud.firestore {}'],
      ['rtdb', { rules: {} }],
    ]);
  });

  test('rules built at run time are not reported', () => {
    const h = harness({
      'x.ts': `import { setRules } from 'pyric/sandbox/database'; declare const r: any; setRules({}, r);`,
    });
    expect(findEmbeddedRules(h.ev, [h.file('x.ts')], ROOT)).toEqual([]);
  });

  test('preserves __proto__ keys as own properties when materializing RTDB rules objects', () => {
    const h = harness({
      'proto.ts': `
        import { setRules } from 'pyric/sandbox/database';
        const dbRules = { rules: { ['__proto__']: { '.read': true } } };
        setRules({}, dbRules);
      `,
    });
    const found = findEmbeddedRules(h.ev, [h.file('proto.ts')], ROOT);
    expect(found).toHaveLength(1);
    const rulesRoot = (found[0]!.rules as { rules: Record<string, unknown> }).rules;
    expect(Object.getPrototypeOf(rulesRoot)).toBe(Object.prototype);
    expect(Object.hasOwn(rulesRoot, '__proto__')).toBe(true);
    expect(rulesRoot['__proto__']).toEqual({ '.read': true });
  });
});
