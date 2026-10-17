/**
 * Realtime Database rules simulated across several database instances: a
 * case names the instance it runs on, its data holds one tree per instance,
 * and a rule's `root` and `data` read only the tree of the case's instance,
 * as production evaluates them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainCase, renderRtdbCoverage, rtdbRules, RulesCompileError } from 'pyric/rules';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory holding `files`, keyed by name. Returns its firebase.json path. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-rtdb-instances-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return join(dir, 'firebase.json');
}

const membersRulesText = `{
  // a room's children are readable by the room's members
  "rules": {
    "rooms": {
      "$roomId": {
        "$child": {
          ".read": "root.child('rooms/' + $roomId + '/members').child(auth.uid).exists()",
        },
      },
    },
  },
}`;

const membersOnly = {
  rules: {
    rooms: {
      $roomId: {
        $child: {
          '.read': "root.child('rooms/' + $roomId + '/members').child(auth.uid).exists()",
        },
      },
    },
  },
};

const membersOnShard = { rooms: { r1: { members: { alice: true }, chat: { m1: 'hi' } } } };

describe('a case names the instance whose tree its rules read', () => {
  test('root reads only the tree of the case instance', () => {
    const summary = rtdbRules(membersOnly).simulate([
      {
        description: 'chat read on the instance without the members list is denied',
        expectation: 'DENY',
        operation: 'read',
        instance: 'demo-app-default-rtdb',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-1': membersOnShard } },
      },
      {
        description: 'chat read on the instance holding the members list is allowed',
        expectation: 'ALLOW',
        operation: 'read',
        instance: 'demo-app-shard-1',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-1': membersOnShard } },
      },
    ]);
    expect(summary.cases.map((c) => [c.decision, c.instance])).toEqual([
      ['DENY', 'demo-app-default-rtdb'],
      ['ALLOW', 'demo-app-shard-1'],
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([2, 0, 0]);
  });

  test('each trace entry names the instance whose tree the rule read', () => {
    const [result] = rtdbRules(membersOnly).simulate([
      {
        expectation: 'DENY',
        operation: 'read',
        instance: 'demo-app-default-rtdb',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-1': membersOnShard } },
      },
    ]).cases;
    expect(result!.trace).toEqual([
      {
        path: '/rooms/$roomId/$child',
        kind: 'read',
        conditionText: "root.child('rooms/' + $roomId + '/members').child(auth.uid).exists()",
        verdict: 'DENY',
        pathVariableBindings: { $roomId: 'r1', $child: 'chat' },
        instance: 'demo-app-default-rtdb',
      },
    ]);
  });
});

describe('writes and updates read the tree of their instance', () => {
  const memberWrites = {
    rules: {
      rooms: {
        $roomId: {
          chat: {
            '.write': "root.child('rooms/' + $roomId + '/members').child(auth.uid).exists()",
          },
          title: {
            '.write': "root.child('rooms/' + $roomId + '/members').child(auth.uid).exists()",
          },
        },
      },
    },
  };

  test('a write and an update on the instance without the members list are denied, and on its own instance allowed', () => {
    const data = { instances: { 'demo-app-shard-1': { rooms: { r1: { members: { alice: true } } } } } };
    const cases = ['demo-app-default-rtdb', 'demo-app-shard-1'].flatMap((instance) => {
      const expectation = instance === 'demo-app-shard-1' ? 'ALLOW' as const : 'DENY' as const;
      return [
        { expectation, operation: 'write' as const, instance, path: '/rooms/r1/chat', auth: 'alice', newData: { m1: 'hi' }, data },
        { expectation, operation: 'update' as const, instance, path: '/rooms/r1', auth: 'alice', newData: { title: 'x', 'chat/m1': 'hi' }, data },
      ];
    });
    const summary = rtdbRules(memberWrites).simulate(cases);
    expect(summary.cases.map((c) => [c.instance, c.case.operation, c.decision])).toEqual([
      ['demo-app-default-rtdb', 'write', 'DENY'],
      ['demo-app-default-rtdb', 'update', 'DENY'],
      ['demo-app-shard-1', 'write', 'ALLOW'],
      ['demo-app-shard-1', 'update', 'ALLOW'],
    ]);
    expect(summary.failed).toBe(0);
  });
});

describe('instance names', () => {
  test('compare as the SDK names them, in lowercase', () => {
    const [result] = rtdbRules(membersOnly).simulate([
      {
        expectation: 'ALLOW',
        operation: 'read',
        instance: 'Demo-App-Shard-1',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'DEMO-APP-SHARD-1': membersOnShard } },
      },
    ]).cases;
    expect([result!.instance, result!.decision]).toEqual(['demo-app-shard-1', 'ALLOW']);
  });

  test('select an instance as getDatabase does: by name, by database URL, or the default keyword', () => {
    const ruleset = rtdbRules({ rules: { '.read': 'data.exists()' } });
    const data = { instances: { 'demo-app-shard-1': { a: 1 }, default: { b: 1 } } };
    const results = ruleset.simulate([
      { expectation: 'ALLOW', operation: 'read', instance: 'https://demo-app-shard-1.firebaseio.com', path: '/', data },
      { expectation: 'ALLOW', operation: 'read', instance: 'default', path: '/', data },
    ]).cases;
    expect(results.map((r) => [r.instance, r.decision])).toEqual([
      ['demo-app-shard-1', 'ALLOW'],
      ['(default)', 'ALLOW'],
    ]);
  });

  test('a name getDatabase refuses is unsupported, with the SDK error', () => {
    const [result] = rtdbRules(membersOnly).simulate([
      { expectation: 'DENY', operation: 'read', instance: 'not.a/name', path: '/rooms/r1/chat' },
    ]).cases;
    expect(result!.decision).toBe('UNSUPPORTED');
    expect(result!.reason).toStartWith('"not.a/name" is not a database instance name: FIREBASE FATAL ERROR:');
  });
});

describe('a ruleset whose rules apply on every instance', () => {
  test('without an instance, a data object whose one key is instances is a tree with an /instances child', () => {
    const ruleset = rtdbRules({ rules: { instances: { $id: { '.read': 'data.exists()' } } } });
    const [result] = ruleset.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/instances/a', data: { instances: { a: { x: 1 } } } },
    ]).cases;
    expect(result!.decision).toBe('ALLOW');
    expect(result!.instance).toBeUndefined();
    expect(result!.trace.every((entry) => entry.instance === undefined)).toBe(true);
  });
});

describe('rtdbRules.fromFirebaseJson', () => {
  test('applies each instance its rules file, and a case without an instance runs on the default instance', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({
        database: [
          { instance: 'demo-app-default-rtdb', rules: 'database.rules.json' },
          { instance: 'demo-app-shard-1', rules: 'database.rules.json' },
        ],
      }),
      '.firebaserc': JSON.stringify({ projects: { default: 'demo-app' } }),
      'database.rules.json': membersRulesText,
    });
    const summary = rtdbRules.fromFirebaseJson(firebaseJson).simulate([
      {
        description: 'chat read on the wrong instance is denied',
        expectation: 'DENY',
        operation: 'read',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-1': membersOnShard } },
      },
      {
        expectation: 'ALLOW',
        operation: 'read',
        instance: 'demo-app-shard-1',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-1': membersOnShard } },
      },
    ]);
    expect(summary.cases.map((c) => [c.instance, c.decision])).toEqual([
      ['demo-app-default-rtdb', 'DENY'],
      ['demo-app-shard-1', 'ALLOW'],
    ]);
    expect([summary.passed, summary.failed, summary.unsupported]).toEqual([2, 0, 0]);
  });

  test('each instance applies the rules file firebase.json deploys to it, and coverage reports each file', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({
        database: [
          { instance: 'demo-app-default-rtdb', rules: 'default.rules.json' },
          { instance: 'demo-app-shard-1', rules: 'shard.rules.json' },
        ],
      }),
      'default.rules.json': '{ "rules": { ".read": true } }',
      'shard.rules.json': '{\n  "rules": {\n    ".read": "auth != null"\n  }\n}',
    });
    const ruleset = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' });
    const summary = ruleset.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/' },
      { expectation: 'DENY', operation: 'read', instance: 'demo-app-shard-1', path: '/' },
    ]);
    expect(summary.cases.map((c) => [c.instance, c.decision, c.matchedRule])).toEqual([
      ['demo-app-default-rtdb', 'ALLOW', 'true'],
      ['demo-app-shard-1', 'DENY', 'auth != null'],
    ]);
    expect(summary.coverage.files.map((f) => [f.file, f.total, f.covered])).toEqual([
      ['default.rules.json', 1, 1],
      ['shard.rules.json', 1, 1],
    ]);
    expect(summary.coverage.rules.map((r) => [r.file, r.path, r.kind, r.line, r.status])).toEqual([
      ['default.rules.json', '/', 'read', 1, 'allow'],
      ['shard.rules.json', '/', 'read', 3, 'deny'],
    ]);
    expect(renderRtdbCoverage(summary.coverage)).toContain('shard.rules.json / .read (line 3): deny (allow 0, deny 1, error 0)');
  });

  test('a case on an instance firebase.json deploys no rules to is unsupported, naming the instances it does', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ instance: 'demo-app-shard-1', rules: 'database.rules.json' }] }),
      'database.rules.json': membersRulesText,
    });
    const ruleset = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' });
    const [onDefault, misspelled] = ruleset.simulate([
      { expectation: 'DENY', operation: 'read', path: '/rooms/r1/chat' },
      { expectation: 'DENY', operation: 'read', instance: 'demo-app-shard-2', path: '/rooms/r1/chat' },
    ]).cases;
    expect([onDefault!.decision, onDefault!.instance, onDefault!.reason]).toEqual([
      'UNSUPPORTED',
      'demo-app-default-rtdb',
      'this ruleset has no rules for the default instance "demo-app-default-rtdb"; it holds rules for "demo-app-shard-1".',
    ]);
    expect([misspelled!.decision, misspelled!.reason]).toEqual([
      'UNSUPPORTED',
      'this ruleset has no rules for database instance "demo-app-shard-2"; it holds rules for "demo-app-shard-1".',
    ]);
  });

  test('data on an instance firebase.json does not declare is unsupported rather than ignored', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ instance: 'demo-app-shard-1', rules: 'database.rules.json' }] }),
      'database.rules.json': membersRulesText,
    });
    const [result] = rtdbRules.fromFirebaseJson(firebaseJson).simulate([
      {
        expectation: 'ALLOW',
        operation: 'read',
        instance: 'demo-app-shard-1',
        path: '/rooms/r1/chat',
        auth: 'alice',
        data: { instances: { 'demo-app-shard-2': membersOnShard } },
      },
    ]).cases;
    expect([result!.decision, result!.reason]).toEqual([
      'UNSUPPORTED',
      'data.instances names "demo-app-shard-2", which this ruleset does not declare; it holds rules for "demo-app-shard-1".',
    ]);
  });
});

describe('rtdbRules.fromFirebaseJson reads firebase.json as firebase deploy does', () => {
  test('a deploy target deploys to every instance .firebaserc maps it to for the project', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ target: 'main', rules: 'database.rules.json' }] }),
      '.firebaserc': JSON.stringify({
        projects: { default: 'demo-app' },
        targets: { 'demo-app': { database: { main: ['demo-app-default-rtdb', 'demo-app-shard-1'] } } },
      }),
      'database.rules.json': membersRulesText,
    });
    const summary = rtdbRules.fromFirebaseJson(firebaseJson).simulate([
      { expectation: 'DENY', operation: 'read', path: '/rooms/r1/chat', auth: 'alice' },
      { expectation: 'DENY', operation: 'read', instance: 'demo-app-shard-1', path: '/rooms/r1/chat', auth: 'alice' },
    ]);
    expect(summary.cases.map((c) => [c.instance, c.decision])).toEqual([
      ['demo-app-default-rtdb', 'DENY'],
      ['demo-app-shard-1', 'DENY'],
    ]);
  });

  test('a deploy target no mapping resolves throws, naming the target and the fix', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ target: 'main', rules: 'database.rules.json' }] }),
      'database.rules.json': membersRulesText,
    });
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(
      'rtdbRules.fromFirebaseJson: firebase.json database[0] deploys to target "main", and no project id is set: pass { projectId } or set projects.default in .firebaserc.',
    );
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' })).toThrow(
      '.firebaserc maps it to no instance for project "demo-app" (firebase target:apply database main <instance>)',
    );
  });

  test('a single database object deploys to the default instance', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: { rules: 'database.rules.json' } }),
      'database.rules.json': '{ "rules": { ".read": true } }',
    });
    const [named, mixedCase, unnamed] = [
      rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' }),
      rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'My-App' }),
      rtdbRules.fromFirebaseJson(firebaseJson),
    ].map((ruleset) => ruleset.simulate([{ expectation: 'ALLOW', operation: 'read', path: '/' }]).cases[0]!);
    expect([named!.instance, named!.decision]).toEqual(['demo-app-default-rtdb', 'ALLOW']);
    // Production SDK lowercases host-derived instance names (rtdb-modular-database-url-instance.json).
    expect([mixedCase!.instance, mixedCase!.decision]).toEqual(['my-app-default-rtdb', 'ALLOW']);
    // Without a project id the default instance has no name to give.
    expect([unnamed!.instance, unnamed!.decision]).toEqual(['(default)', 'ALLOW']);
  });

  test('an unconfigured database key deploys database.rules.json to the lowercased default instance for a mixed-case projectId', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({}),
      'database.rules.json': '{ "rules": { ".read": true } }',
    });
    const ruleset = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'My-App' });
    const [result] = ruleset.simulate([{ expectation: 'ALLOW', operation: 'read', path: '/' }]).cases;
    expect([result!.instance, result!.decision]).toEqual(['my-app-default-rtdb', 'ALLOW']);
    expect(ruleset.toJSON()).toEqual({ rules: { '.read': true } });
  });

  test('a rules file that is not rules text throws RulesCompileError naming the file', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ instance: 'demo-app-shard-1', rules: 'database.rules.json' }] }),
      'database.rules.json': '{ "rules": { ".read": true ',
    });
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(RulesCompileError);
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(/database\.rules\.json: Realtime Database rules text is not valid JSON: /);
  });

  test('a rules file firebase.json deploys that does not exist throws, naming the instance', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ instance: 'demo-app-shard-1', rules: 'missing.rules.json' }] }),
    });
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(
      /missing\.rules\.json does not exist, and firebase\.json database\[0\] deploys it to database instance "demo-app-shard-1"\.$/,
    );
  });

  test('a database config the Firebase CLI refuses throws its error', () => {
    const firebaseJson = project({ 'firebase.json': JSON.stringify({ database: [{ rules: 'database.rules.json' }] }) });
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(
      'rtdbRules.fromFirebaseJson: firebase.json database[0]: Must supply either "target" or "instance" in database config',
    );
  });
});

describe('a per-instance ruleset names the instance in what it reports', () => {
  function shardProject(): string {
    return project({
      'firebase.json': JSON.stringify({
        database: [
          { instance: 'demo-app-default-rtdb', rules: 'default.rules.json' },
          { instance: 'demo-app-shard-1', rules: 'shard.rules.json' },
        ],
      }),
      'default.rules.json': '{ "rules": { ".read": true } }',
      'shard.rules.json': '{ "rules": { ".read": "auth != null", "rooms": { ".write": "auth.uid == 1" } } }',
    });
  }

  test('explainCase names the instance a case ran on', () => {
    const ruleset = rtdbRules.fromFirebaseJson(shardProject(), { projectId: 'demo-app' });
    const [result] = ruleset.simulate([
      { description: 'anonymous shard read', expectation: 'ALLOW', operation: 'read', instance: 'demo-app-shard-1', path: '/' },
    ]).cases;
    expect(explainCase(result!).split('\n').slice(0, 2)).toEqual([
      'FAIL: anonymous shard read',
      '  read / on demo-app-shard-1 (expected ALLOW, got DENY)',
    ]);
    expect(ruleset.explain({ expectation: 'ALLOW', operation: 'read', path: '/' }).instance).toBe('demo-app-default-rtdb');
  });

  test('lint reports each rules file once, naming it', () => {
    const defaultText = '{ "rules": { ".read": true } }';
    const shardText = '{ "rules": { ".read": "auth != null", "rooms": { ".write": "auth.uid == 1" } } }';
    const firebaseJson = project({
      'firebase.json': JSON.stringify({
        database: [
          { instance: 'demo-app-default-rtdb', rules: 'default.rules.json' },
          { instance: 'demo-app-shard-1', rules: 'shard.rules.json' },
          { instance: 'demo-app-shard-2', rules: 'shard.rules.json' },
        ],
      }),
      'default.rules.json': defaultText,
      'shard.rules.json': shardText,
    });
    const issues = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' }).lint();
    const defaultIssues = rtdbRules(defaultText).lint();
    const shardIssues = rtdbRules(shardText).lint();
    expect(defaultIssues.length + shardIssues.length).toBeGreaterThan(0);
    expect(issues).toEqual([
      ...defaultIssues.map((issue) => ({ ...issue, file: 'default.rules.json' })),
      ...shardIssues.map((issue) => ({ ...issue, file: 'shard.rules.json' })),
    ]);
  });

  test('toJSON returns the default instance rules, so JSON.stringify serializes the ruleset', () => {
    const ruleset = rtdbRules.fromFirebaseJson(shardProject(), { projectId: 'Demo-App' });
    expect(ruleset.toJSON()).toEqual({ rules: { '.read': true } });
    expect(JSON.parse(JSON.stringify({ ruleset }))).toEqual({ ruleset: { rules: { '.read': true } } });
  });
});

describe('rtdbRules.fromFirebaseJson reads .firebaserc only when it needs it', () => {
  test('a projectId option skips a .firebaserc that does not parse', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: { rules: 'database.rules.json' } }),
      '.firebaserc': '{ "projects": ',
      'database.rules.json': '{ "rules": { ".read": true } }',
    });
    const [result] = rtdbRules.fromFirebaseJson(firebaseJson, { projectId: 'demo-app' })
      .simulate([{ expectation: 'ALLOW', operation: 'read', path: '/' }]).cases;
    expect([result!.instance, result!.decision]).toEqual(['demo-app-default-rtdb', 'ALLOW']);
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(/\.firebaserc is not valid JSON: /);
  });

  test('a target mapping that is not a list of names maps the target to no instance', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: [{ target: 'main', rules: 'database.rules.json' }] }),
      '.firebaserc': JSON.stringify({ projects: { default: 'demo-app' }, targets: { 'demo-app': { database: { main: 'demo-app-shard-1' } } } }),
      'database.rules.json': membersRulesText,
    });
    expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow('deploys to target "main", and .firebaserc maps it to no instance for project "demo-app"');
  });
});

describe('rtdbRules.fromFirebaseJson without a file system', () => {
  test('throws saying it reads files, when process.getBuiltinModule is absent as in a browser', () => {
    const firebaseJson = project({
      'firebase.json': JSON.stringify({ database: { rules: 'database.rules.json' } }),
      'database.rules.json': '{ "rules": { ".read": true } }',
    });
    const host = process as { getBuiltinModule?: unknown };
    const original = host.getBuiltinModule;
    delete host.getBuiltinModule;
    try {
      expect(() => rtdbRules.fromFirebaseJson(firebaseJson)).toThrow(
        "rtdbRules.fromFirebaseJson reads files, which needs Node.js 20.16 or later, Bun or Deno. Without a file system, pass each instance's rules text to rtdbRules.",
      );
    } finally {
      host.getBuiltinModule = original;
    }
    expect(rtdbRules.fromFirebaseJson(firebaseJson).toJSON()).toEqual({ rules: { '.read': true } });
  });
});
