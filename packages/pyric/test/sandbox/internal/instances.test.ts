import { describe, expect, it } from 'bun:test';
import { load } from '../../database/modular/oracle-conformance.support.js';
import {
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  createDatabaseInstanceRegistry,
  databaseInstanceKey,
  databaseInstanceNamed,
  defaultDatabaseInstance,
  defaultDatabaseInstanceName,
  isCustomDatabaseHost,
  parseDatabaseLocationUrl,
  parseDatabaseUrl,
  resolveDatabaseInstance,
} from '../../../src/sandbox/internal/instances.js';

const CANNOT_PARSE =
  'FIREBASE FATAL ERROR: Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com ';
const NOT_ROOT =
  'FIREBASE FATAL ERROR: Database URL must point to the root of a Firebase Database (not including a child path). ';
const INVALID_URL =
  'Invalid Firebase Database URL failed: url argument must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".';

/**
 * Inputs and outputs recorded from the production JS SDK (`firebase` 12.13.0,
 * `@firebase/database` 1.1.3): `getDatabase(app, url)` followed by reading
 * `db._repo.repoInfo_.namespace` and `repoInfo_.toURLString()`, or the message
 * `getDatabase` threw.
 */
const PRODUCTION_SDK_TABLE: ReadonlyArray<
  { input: string; name: string; url: string } | { input: string; error: string }
> = [
  { input: 'https://my-instance.firebaseio.com', name: 'my-instance', url: 'https://my-instance.firebaseio.com/' },
  { input: 'https://my-instance.firebaseio.com/', name: 'my-instance', url: 'https://my-instance.firebaseio.com/' },
  { input: 'HTTPS://MY-INSTANCE.FIREBASEIO.COM/', name: 'my-instance', url: 'https://my-instance.firebaseio.com/' },
  { input: 'my-instance.firebaseio.com', name: 'my-instance', url: 'https://my-instance.firebaseio.com/' },
  { input: 'wss://my-instance.firebaseio.com', name: 'my-instance', url: 'https://my-instance.firebaseio.com/' },
  { input: 'https://my-instance.firebaseio.com:443', name: 'my-instance', url: 'https://my-instance.firebaseio.com:443/' },
  { input: 'https://my-instance.firebaseio-demo.com', name: 'my-instance', url: 'https://my-instance.firebaseio-demo.com/' },
  {
    input: 'https://my-instance.europe-west1.firebasedatabase.app',
    name: 'my-instance',
    url: 'https://my-instance.europe-west1.firebasedatabase.app/',
  },
  {
    input: 'https://My-Instance.Europe-West1.Firebasedatabase.App/',
    name: 'my-instance',
    url: 'https://my-instance.europe-west1.firebasedatabase.app/',
  },
  {
    input: 'https://my-instance.asia-southeast1.firebasedatabase.app',
    name: 'my-instance',
    url: 'https://my-instance.asia-southeast1.firebasedatabase.app/',
  },
  { input: 'http://localhost:9000?ns=db1', name: 'db1', url: 'http://localhost:9000/?ns=db1' },
  { input: 'http://localhost:9000/?ns=DB1', name: 'DB1', url: 'http://localhost:9000/?ns=DB1' },
  { input: 'http://localhost:9000?NS=db1', name: '', url: 'http://localhost:9000/' },
  { input: 'http://localhost:9000', name: '', url: 'http://localhost:9000/' },
  { input: 'http://127.0.0.1:9000?ns=db1', name: 'db1', url: 'http://127.0.0.1:9000/?ns=db1' },
  { input: 'https://proxy.example.com?ns=db1', name: 'db1', url: 'https://proxy.example.com/?ns=db1' },
  { input: 'https://my-instance.firebaseio.com?ns=other', name: 'other', url: 'https://my-instance.firebaseio.com/?ns=other' },
  { input: 'my-instance', error: CANNOT_PARSE },
  { input: 'https://example.com', error: CANNOT_PARSE },
  { input: 'https://my-instance.firebaseio.com?ns=', error: CANNOT_PARSE },
  {
    input: 'https://firebase.com',
    error: 'FIREBASE FATAL ERROR: firebase.com is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead ',
  },
  {
    input: 'https://x.firebase.com',
    error: 'FIREBASE FATAL ERROR: x.firebase.com is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead ',
  },
  { input: 'https://my-instance.firebaseio.com/users', error: NOT_ROOT },
  { input: 'https://my-instance.firebaseio.com/.info', error: NOT_ROOT },
  { input: 'https://my-instance.firebaseio.com/a.b', error: INVALID_URL },
  { input: 'https://bad#name.firebaseio.com', error: INVALID_URL },
  { input: 'https://my-instance.firebaseio.com?ns=a.b', error: INVALID_URL },
];

describe('parseDatabaseUrl matches the production SDK', () => {
  for (const row of PRODUCTION_SDK_TABLE) {
    if ('error' in row) {
      it(`rejects ${JSON.stringify(row.input)}`, () => {
        let thrown: unknown;
        try {
          parseDatabaseUrl(row.input);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).constructor).toBe(Error);
        expect((thrown as Error).message).toBe(row.error);
      });
    } else {
      it(`maps ${JSON.stringify(row.input)} to instance ${JSON.stringify(row.name)}`, () => {
        expect(parseDatabaseUrl(row.input)).toEqual({ name: row.name, url: row.url });
      });
    }
  }

  it('rtdb-modular#M39 replays every URL form in the production SDK observation', () => {
    const behavior = load('rtdb-modular-database-url-instance.json') as {
      urls: Record<string, { name: string; url: string } | { error: string; errorClass: string }>;
      projectDefault: { name: string; url: string; nameIsProjectIdDefaultRtdb: boolean };
    };
    for (const [input, observed] of Object.entries(behavior.urls)) {
      if ('error' in observed) {
        let thrown: unknown;
        try {
          parseDatabaseUrl(input);
        } catch (error) {
          thrown = error;
        }
        expect({ input, errorClass: (thrown as Error)?.constructor?.name, error: (thrown as Error)?.message })
          .toEqual({ input, errorClass: observed.errorClass, error: observed.error });
      } else {
        expect({ input, ...parseDatabaseUrl(input) }).toEqual({ input, ...observed });
      }
    }
    const { name, url, nameIsProjectIdDefaultRtdb } = behavior.projectDefault;
    expect(nameIsProjectIdDefaultRtdb).toBe(true);
    const projectId = name.slice(0, -'-default-rtdb'.length);
    expect(defaultDatabaseInstance(projectId)).toEqual({ name, url });
  });

  it('reports a URL that parses back to the same instance', () => {
    for (const row of PRODUCTION_SDK_TABLE) {
      if ('error' in row) continue;
      expect(parseDatabaseUrl(parseDatabaseUrl(row.input).url)).toEqual({ name: row.name, url: row.url });
    }
  });
});

describe('database instance names', () => {
  it('derives the default instance from the project id as production does', () => {
    expect(defaultDatabaseInstanceName('demo-proj')).toBe('demo-proj-default-rtdb');
    expect(defaultDatabaseInstance('demo-proj')).toEqual({
      name: 'demo-proj-default-rtdb',
      url: 'https://demo-proj-default-rtdb.firebaseio.com/',
    });
  });

  it('builds the instance a firebase.json `instance` entry names', () => {
    expect(databaseInstanceNamed('my-instance')).toEqual({
      name: 'my-instance',
      url: 'https://my-instance.firebaseio.com/',
    });
    expect(databaseInstanceNamed('MY-INSTANCE').name).toBe('my-instance');
    expect(() => databaseInstanceNamed('my.instance')).toThrow(CANNOT_PARSE);
    expect(() => databaseInstanceNamed('')).toThrow(CANNOT_PARSE);
  });

  it('resolves a sandbox handle argument: no URL or the default keyword, a bare name, or a URL', () => {
    expect(resolveDatabaseInstance()).toBeUndefined();
    expect(resolveDatabaseInstance('')).toBeUndefined();
    expect(resolveDatabaseInstance('  DEFAULT  ')).toBeUndefined();
    expect(resolveDatabaseInstance('MY-INSTANCE')).toEqual(databaseInstanceNamed('my-instance'));
    expect(resolveDatabaseInstance('https://my-instance.europe-west1.firebasedatabase.app')?.name).toBe('my-instance');
    expect(() => resolveDatabaseInstance('https://my-instance.firebaseio.com/users')).toThrow(NOT_ROOT);
    expect(() => resolveDatabaseInstance('my_instance')).toThrow(CANNOT_PARSE);
  });

  it('keys an instance by name, with the default instance under its own name when the project is known', () => {
    expect(databaseInstanceKey(undefined)).toBe(UNNAMED_DEFAULT_DATABASE_INSTANCE);
    expect(databaseInstanceKey(databaseInstanceNamed('other'))).toBe('other');
    expect(databaseInstanceKey(undefined, 'p-default-rtdb')).toBe('p-default-rtdb');
    expect(databaseInstanceKey(parseDatabaseUrl('https://p-default-rtdb.europe-west1.firebasedatabase.app'), 'p-default-rtdb'))
      .toBe('p-default-rtdb');
  });
});

describe('parseDatabaseLocationUrl matches the SDK refFromURL parse', () => {
  it('returns the instance, host and decoded location', () => {
    expect(parseDatabaseLocationUrl('https://Other.firebaseio.com/a/b%20c')).toEqual({
      instance: { name: 'other', url: 'https://other.firebaseio.com/' },
      host: 'other.firebaseio.com',
      path: '/a/b c',
    });
    expect(parseDatabaseLocationUrl('https://reg.europe-west1.firebasedatabase.app').path).toBe('/');
    expect(parseDatabaseLocationUrl('https://host.firebaseio.com/x?ns=nsname').instance)
      .toEqual({ name: 'nsname', url: 'https://host.firebaseio.com/?ns=nsname' });
  });

  it('throws the SDK errors under the refFromURL name', () => {
    expect(() => parseDatabaseLocationUrl('https://my-instance.firebaseio.com/a.b')).toThrow(
      'refFromURL failed: url argument must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".',
    );
    expect(() => parseDatabaseLocationUrl('https://example.com/a')).toThrow(CANNOT_PARSE);
  });

  it('checks the host only for firebaseio.com and firebaseio-demo.com databases', () => {
    expect(isCustomDatabaseHost('a.firebaseio.com')).toBe(false);
    expect(isCustomDatabaseHost('a.firebaseio-demo.com')).toBe(false);
    expect(isCustomDatabaseHost('a.europe-west1.firebasedatabase.app')).toBe(true);
    expect(isCustomDatabaseHost('localhost:9000')).toBe(true);
  });
});

describe('createDatabaseInstanceRegistry', () => {
  it('creates one entry per instance name and enumerates them', () => {
    const created: string[] = [];
    const registry = createDatabaseInstanceRegistry({ create: (key) => { created.push(key); return { key }; } });
    const a = registry.getOrCreate(registry.keyOf(parseDatabaseUrl('https://a.firebaseio.com')));
    const aRegional = registry.getOrCreate(registry.keyOf(parseDatabaseUrl('https://a.europe-west1.firebasedatabase.app/')));
    const fallback = registry.getOrCreate(registry.keyOf(undefined));
    expect(aRegional).toBe(a);
    expect(registry.get('a')).toBe(a);
    expect(registry.get('b')).toBeUndefined();
    expect(created).toEqual(['a', UNNAMED_DEFAULT_DATABASE_INSTANCE]);
    expect([...registry.entries()].map(([key]) => key)).toEqual(['a', UNNAMED_DEFAULT_DATABASE_INSTANCE]);
    expect(registry.defaultKey).toBe(UNNAMED_DEFAULT_DATABASE_INSTANCE);
    expect(fallback).toEqual({ key: UNNAMED_DEFAULT_DATABASE_INSTANCE });
  });

  it('collapses the project default instance URL onto the default entry', () => {
    const registry = createDatabaseInstanceRegistry({ create: (key) => ({ key }), defaultName: 'p-default-rtdb' });
    const implicit = registry.getOrCreate(registry.keyOf(undefined));
    const named = registry.getOrCreate(registry.keyOf(parseDatabaseUrl('https://p-default-rtdb.firebaseio.com')));
    expect(named).toBe(implicit);
    expect(registry.defaultKey).toBe('p-default-rtdb');
    expect([...registry.entries()]).toHaveLength(1);
  });
});
