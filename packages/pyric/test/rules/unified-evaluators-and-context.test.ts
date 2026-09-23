import { describe, expect, test } from 'bun:test';
import {
  DataSnapshot,
  evaluateRtdbExpression,
  type EvalContext,
} from '../../src/rules/rtdb/grammar/simulator.js';
import { compileRtdbRules, simulateRtdbRules } from '../../src/rules/rtdb/compiled-rules.js';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';

const firestoreHandler = new SimulateFirestoreRulesHandler();
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { Bytes } from '../../src/rules/simulator/wrappers/bytes.js';
import { EvalError } from '../../src/rules/simulator/eval-error.js';
import { normalizeAuthState } from '../../src/sandbox/sandbox-context.js';

describe('Seam 1: Unified Multi-Tenant & Provider Auth Context Across Evaluators', () => {
  test('normalizeAuthState projects nested token.firebase.tenant to top-level auth.tenant when top-level tenant is omitted', () => {
    const normalized = normalizeAuthState({
      uid: 'user-1',
      token: {
        firebase: {
          tenant: 'tenant-from-token',
          sign_in_provider: 'google.com',
        },
      },
    });
    expect(normalized?.tenant).toBe('tenant-from-token');
    expect((normalized?.token?.firebase as Record<string, unknown>)?.tenant).toBe('tenant-from-token');
  });

  test('Firestore simulator normalizes top-level auth.tenant into request.auth.token.firebase.tenant and request.auth.tenant', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /orgs/{orgId} {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == 'tenant-alpha'
        && request.auth.uid == 'alice';
    }
  }
}`;
    const res = firestoreHandler.simulate(rules, [
      {
        description: 'tenant projected from top-level auth.tenant',
        method: 'get',
        path: 'orgs/o1',
        auth: { uid: 'alice', tenant: 'tenant-alpha' },
        expectation: 'ALLOW',
      },
    ]);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.results[0]?.decision).toBe('ALLOW');
      expect(res.data.results[0]?.state).toBe('PASSED');
    }
  });

  test('RTDB simulator exposes auth.provider, auth.tenant, and auth.token.firebase.sign_in_provider / identities', () => {
    const compiled = compileRtdbRules({
      rules: {
        tenants: {
          $tenantId: {
            '.read':
              "auth != null && auth.provider == 'google.com' && auth.tenant == $tenantId && auth.token.firebase.tenant == $tenantId && auth.token.firebase.sign_in_provider == 'google.com' && auth.token.firebase.identities['google.com'][0] == 'g-123'",
          },
        },
      },
    });

    const sim = simulateRtdbRules(compiled, {
      operation: 'read',
      path: '/tenants/acme',
      auth: {
        uid: 'u1',
        tenant: 'acme',
        token: {
          firebase: {
            sign_in_provider: 'google.com',
            identities: { 'google.com': ['g-123'] },
          },
        },
      },
      mockData: { tenants: { acme: { active: true } } },
    });

    expect(sim.success).toBe(true);
    if (sim.success) {
      expect(sim.data.allowed).toBe(true);
    }
  });
});

describe('Seam 2: RTDB DataSnapshot getPriority, Path Normalization & Exception Safety', () => {
  const baseCtx: EvalContext = {
    auth: { uid: 'u1', token: {} },
    data: new DataSnapshot({ '.value': 'urgent-task', '.priority': 100 }, '/tasks/t1'),
    newData: new DataSnapshot('hello_world', '/tasks/t1'),
    root: new DataSnapshot(
      {
        tasks: {
          t1: { title: 'hello', '.priority': 50 },
          t2: { title: 'world' },
        },
      },
      '/',
    ),
    now: 1700000000000,
    pathVariableBindings: {},
  };

  test('DataSnapshot.getPriority() returns node priority and val() unwraps .value/.priority payload', () => {
    expect(evaluateRtdbExpression('data.getPriority()', baseCtx)).toBe(100);
    expect(evaluateRtdbExpression('data.val()', baseCtx)).toBe('urgent-task');
    expect(evaluateRtdbExpression("root.child('tasks/t1').getPriority()", baseCtx)).toBe(50);
    expect(evaluateRtdbExpression("root.child('tasks/t2').getPriority()", baseCtx)).toBeNull();
  });

  test('DataSnapshot.child() normalizes "." and ".." relative path segments', () => {
    expect(evaluateRtdbExpression("root.child('tasks/./t1/title').val()", baseCtx)).toBe('hello');
    expect(evaluateRtdbExpression("root.child('tasks/t1/../t2/title').val()", baseCtx)).toBe('world');
  });

  test('RtdbString.matches() and replace() handle malformed regex patterns without uncaught SyntaxError and support regex string literals', () => {
    expect(evaluateRtdbExpression("newData.val().matches('[unclosed')", baseCtx)).toBe(false);
    expect(evaluateRtdbExpression("newData.val().replace('/_[a-z]+/', '-there')", baseCtx)).toBe(
      'hello-there',
    );
  });

  test('SimulateHandler.execute treats runtime exceptions inside .validate expressions as validation denials instead of crashing', () => {
    const compiled = compileRtdbRules({
      rules: {
        items: {
          $id: {
            '.write': true,
            '.validate': "newData.val().matches('[unclosed')",
          },
        },
      },
    });

    const res = simulateRtdbRules(compiled, {
      operation: 'write',
      path: '/items/item1',
      auth: { uid: 'u1' },
      mockData: {},
      newData: 'abc',
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.allowed).toBe(false);
    }
  });
});

describe('Seam 3: Firestore Simulator Bytes.fromHex Error Absorption', () => {
  test('Bytes.fromHex throws EvalError on odd-length or invalid hex strings', () => {
    expect(() => Bytes.fromHex('abc')).toThrow(EvalError);
    expect(() => Bytes.fromHex('zzzz')).toThrow(EvalError);
  });
});

describe('Seam 4: Cloud Storage Rules Evaluator Shared CEL Wrapper Parity', () => {
  const evalStorage = (expr: string) => {
    const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if ${expr};
    }
  }
}`);
    return evaluateStorageRules(
      rules,
      {
        request: {
          auth: { uid: 'alice', tenant: 'acme' },
          method: 'read',
          path: '/b/my-bucket/o/files/report.pdf',
          resource: {
            size: 1024,
            contentType: 'application/pdf',
            metadata: { a: '1', b: '2' },
          },
        },
        resource: {
          size: 1024,
          contentType: 'application/pdf',
          metadata: { a: '1', b: 'old' },
          name: 'files/report.pdf',
          bucket: 'my-bucket',
          timeCreated: '2026-03-15T14:30:45.123Z',
          updated: '2026-03-15T15:00:00.000Z',
          generation: 1,
          metageneration: 1,
        },
      },
      new Date('2026-03-15T16:00:00.000Z'),
    );
  };

  test('evaluates Timestamp instance methods (.year(), .month(), .day(), .hours(), .toMillis()) in Cloud Storage rules', () => {
    expect(evalStorage('request.time.year() == 2026 && request.time.month() == 3 && request.time.day() == 15').allowed).toBe(true);
    expect(evalStorage('resource.timeCreated.year() == 2026 && resource.timeCreated.hours() == 14').allowed).toBe(true);
    expect(evalStorage('timestamp.date(2026, 3, 15).month() == 3').allowed).toBe(true);
  });

  test('evaluates Duration instance methods (.seconds(), .abs()) and duration.time() in Cloud Storage rules', () => {
    expect(evalStorage('duration.value(2, "h").seconds() == 7200').allowed).toBe(true);
    expect(evalStorage('duration.time(1, 30, 0, 0).seconds() == 5400').allowed).toBe(true);
  });

  test('evaluates Map.diff() and MapDiff set methods (.addedKeys(), .changedKeys(), .affectedKeys(), .hasOnly()) in Cloud Storage rules', () => {
    expect(
      evalStorage('request.resource.metadata.diff(resource.metadata).changedKeys().hasOnly(["b"])').allowed,
    ).toBe(true);
    expect(
      evalStorage('request.resource.metadata.diff(resource.metadata).unchangedKeys().hasAll(["a"])').allowed,
    ).toBe(true);
  });

  test('evaluates hashing.* (md5, sha256, crc32c) and String methods (lower, upper, trim, replace, toUtf8) in Cloud Storage rules', () => {
    expect(
      evalStorage('hashing.sha256("hello".toUtf8()).toHexString() == "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824"').allowed,
    ).toBe(true);
    expect(
      evalStorage('hashing.crc32c("hello").toHexString().size() > 0').allowed,
    ).toBe(true);
    expect(
      evalStorage('"  HeLLo_World  ".trim().lower().replace("_", "-") == "hello-world"').allowed,
    ).toBe(true);
  });
});
