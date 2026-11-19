import { describe, expect, it } from 'bun:test';
import { isCustomDatabaseHost, parseDatabaseLocationUrl } from 'pyric/sandbox/internal';
import type { ClientRtdb } from '../../../../src/serve/worker/client/handles.js';
import { rtdbInstanceDatabase, rtdbRef } from '../../../../src/serve/worker/client/rtdb-references.js';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

function captureSyncThrow(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
    return { timing: 'resolved', value: null };
  } catch (err) {
    let name: string = typeof err;
    let message = String(err);
    if (err instanceof Error) {
      name = err.name;
      message = err.message;
    }
    const code = (err as { code?: unknown }).code ?? null;
    return { timing: 'synchronous-throw', name, code, message };
  }
}

function workerRefFromUrl(db: ClientRtdb, url: string) {
  const location = parseDatabaseLocationUrl(url);
  const instance = db.instance;
  if (instance !== undefined) {
    const expectedHost = parseDatabaseLocationUrl(instance.url).host;
    if (!isCustomDatabaseHost(expectedHost) && location.host !== expectedHost) {
      throw new Error(
        `FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found ${location.host} but expected ${expectedHost}) `,
      );
    }
  }
  return rtdbRef(db, location.path);
}

function projectScopedShape(urlString: string, expectedPath: string, projectId: string) {
  const parsed = new URL(urlString);
  const cleanActual = parsed.pathname.replace(/\/$/, '');
  const cleanExpected = expectedPath.replace(/\/$/, '');
  return {
    protocol: parsed.protocol,
    hostIsProjectScoped: parsed.hostname.startsWith(`${projectId}-`),
    endsWithFirebaseio: parsed.hostname.endsWith('.firebaseio.com'),
    pathMatches: cleanActual === cleanExpected,
  };
}

function defineReferenceShapeUrlPlaneSuite(
  planeName: string,
  openPlane: () => Promise<ServedRtdbAdminContext>,
): void {
  describe(`rtdb-modular-reference-shape-url on ${planeName} (M40, M93)`, () => {
    it('matches captured root/nested reference navigation, HTTPS URL serialization, queryIdentity, and refFromURL', async () => {
      const obs = load('rtdb-modular-reference-shape-url') as {
        root: {
          key: string | null;
          parent: null;
          rootKey: string | null;
          toString: Record<string, unknown>;
        };
        nested: {
          key: string;
          parentKey: string;
          rootKey: string | null;
          toString: Record<string, unknown>;
          childToStringMatches: boolean;
        };
        queryIdentity: Record<string, unknown>;
        referenceValidation: {
          invalidRefPaths: Array<Record<string, unknown>>;
          invalidChildPath: Record<string, unknown>;
          emptyChildPath: Record<string, unknown>;
          fragmentUrl: Record<string, unknown>;
          ftpUrl: Record<string, unknown>;
          queryUrl: Record<string, unknown>;
        };
        matchingUrl: {
          key: string;
          value: { ok: boolean };
          toString: Record<string, unknown>;
        };
        mismatchedHost: Record<string, unknown>;
        malformedUrl: Record<string, unknown>;
        terminal: { parent: { child: { ok: boolean } } };
      };

      const ctx = await openPlane();
      const otherClient = await ctx.newClient('other');
      const { rtdb } = ctx;

      const rawMainDb = ctx.db as unknown as ClientRtdb;
      const rawOtherDb = otherClient.db as unknown as ClientRtdb;
      const scopedClient = rtdbInstanceDatabase(rawMainDb, {
        url: 'https://digame-mas-default-rtdb.firebaseio.com/',
      });
      const otherScopedClient = rtdbInstanceDatabase(rawOtherDb, {
        url: 'https://digame-mas-default-rtdb.firebaseio.com/',
      });
      const scopedDb = scopedClient as unknown as typeof ctx.db;
      const otherScopedDb = otherScopedClient as unknown as typeof ctx.db;

      const rootRef = rtdb.ref(scopedDb);
      expect({
        key: rootRef.key,
        parent: rootRef.parent,
        rootKey: rootRef.root.key,
        toString: projectScopedShape(rootRef.toString(), '/', 'digame-mas'),
      }).toEqual(obs.root);

      const basePath = 'pyric_oracle/replay/ref-shape';
      const nestedRef = rtdb.ref(scopedDb, `${basePath}/parent/child`);
      const viaChild = rtdb.child(rtdb.ref(scopedDb, `${basePath}/parent`), 'child');
      await rtdb.set(nestedRef, { ok: true });

      expect({
        key: nestedRef.key,
        parentKey: nestedRef.parent?.key,
        rootKey: nestedRef.root.key,
        toString: projectScopedShape(nestedRef.toString(), `/${basePath}/parent/child`, 'digame-mas'),
        childToStringMatches: viaChild.toString() === nestedRef.toString(),
      }).toEqual(obs.nested);

      const constrained = rtdb.query(nestedRef, rtdb.orderByValue(), rtdb.startAt(1), rtdb.endAt(2));
      const equivalent = rtdb.query(nestedRef, rtdb.endAt(2), rtdb.orderByValue(), rtdb.startAt(1));
      expect({
        referenceToJSON: projectScopedShape(
          nestedRef.toJSON(),
          `/${basePath}/parent/child`,
          'digame-mas',
        ),
        queryToJSON: projectScopedShape(
          constrained.toJSON(),
          `/${basePath}/parent/child`,
          'digame-mas',
        ),
        sameReference: nestedRef.isEqual(viaChild),
        defaultQueryEqualsReference: nestedRef.isEqual(rtdb.query(nestedRef)),
        referenceEqualsDefaultQuery: rtdb.query(nestedRef).isEqual(nestedRef),
        equivalentConstraintOrder: constrained.isEqual(equivalent),
        differentSpec: constrained.isEqual(rtdb.query(nestedRef, rtdb.orderByValue(), rtdb.startAt(2))),
        differentPath: nestedRef.isEqual(rtdb.ref(scopedDb, `${basePath}/other`)),
        differentApp: nestedRef.isEqual(rtdb.ref(otherScopedDb, `${basePath}/parent/child`)),
        nullValue: nestedRef.isEqual(null),
        nonQuery: nestedRef.isEqual({} as never),
      }).toEqual(obs.queryIdentity);

      // Untargeted and custom-port handles format origin + URL-encoded path segments
      expect(rtdb.ref(ctx.db).toString()).toBe('https://demo-pyric-default-rtdb.firebaseio.com/');
      expect(rtdb.ref(ctx.db, 'a b/c').toJSON()).toBe(
        'https://demo-pyric-default-rtdb.firebaseio.com/a%20b/c',
      );
      const customPortDb = rtdbInstanceDatabase(rawMainDb, {
        url: 'http://127.0.0.1:9000/?ns=custom-ns',
      }) as unknown as typeof ctx.db;
      expect(rtdb.ref(customPortDb).toString()).toBe('http://127.0.0.1:9000/');
      expect(rtdb.ref(customPortDb, 'x/y').toJSON()).toBe('http://127.0.0.1:9000/x/y');

      expect(
        ['.', '#', '$', '[', ']'].map((ch) => captureSyncThrow(() => rtdb.ref(scopedDb, `bad${ch}path`))),
      ).toEqual(obs.referenceValidation.invalidRefPaths);
      expect(captureSyncThrow(() => rtdb.child(rootRef, 'bad#path'))).toEqual(
        obs.referenceValidation.invalidChildPath,
      );
      expect(captureSyncThrow(() => rtdb.child(rootRef, ''))).toEqual(
        obs.referenceValidation.emptyChildPath,
      );
      expect(
        captureSyncThrow(() =>
          workerRefFromUrl(
            scopedClient,
            `https://digame-mas-default-rtdb.firebaseio.com/${basePath}/parent/child#frag`,
          ),
        ),
      ).toEqual(obs.referenceValidation.fragmentUrl);
      expect(
        projectScopedShape(
          workerRefFromUrl(
            scopedClient,
            `ftp://digame-mas-default-rtdb.firebaseio.com/${basePath}/parent/child`,
          ).toString(),
          `/${basePath}/parent/child`,
          'digame-mas',
        ),
      ).toEqual(obs.referenceValidation.ftpUrl);
      expect(
        projectScopedShape(
          workerRefFromUrl(
            scopedClient,
            `https://digame-mas-default-rtdb.firebaseio.com/${basePath}/parent/child?x=1`,
          ).toString(),
          `/${basePath}/parent/child`,
          'digame-mas',
        ),
      ).toEqual(obs.referenceValidation.queryUrl);

      const matchedRef = workerRefFromUrl(
        scopedClient,
        `https://digame-mas-default-rtdb.firebaseio.com/${basePath}/parent/child`,
      );
      const matchedSnap = await rtdb.get(matchedRef as unknown as ReturnType<typeof rtdb.ref>);
      expect({
        key: matchedRef.key,
        value: matchedSnap.val(),
        toString: projectScopedShape(matchedRef.toString(), `/${basePath}/parent/child`, 'digame-mas'),
      }).toEqual(obs.matchingUrl);

      const exampleClient = rtdbInstanceDatabase(rawMainDb, {
        url: 'https://example-project-rtdb.firebaseio.com/',
      });
      expect(
        captureSyncThrow(() =>
          workerRefFromUrl(exampleClient, 'https://other-example-project-rtdb.firebaseio.com/x'),
        ),
      ).toEqual(obs.mismatchedHost);
      expect(captureSyncThrow(() => workerRefFromUrl(scopedClient, 'not a url'))).toEqual(
        obs.malformedUrl,
      );

      const stored = await rtdb.get(rtdb.ref(scopedDb, basePath));
      expect(stored.val()).toEqual(obs.terminal);
    });
  });
}

defineReferenceShapeUrlPlaneSuite('served SharedWorker', () => servedRtdbContext());
defineReferenceShapeUrlPlaneSuite('served Node host', () => hostedRtdbContext());
