import {
  child,
  endAt,
  get,
  orderByValue,
  query,
  ref,
  refFromURL,
  set,
  startAt,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  captureInvocation,
  cleanup,
  createClient,
  referenceStringShape,
  repeatStable,
  scenarioPath,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-reference-shape-url',
      matrixRow: 'rtdb-modular#100-105, rtdb-modular#174, rtdb-modular#M93',
      rowIds: [
        'rtdb-modular#100', 'rtdb-modular#101', 'rtdb-modular#102',
        'rtdb-modular#103', 'rtdb-modular#104', 'rtdb-modular#105',
        'rtdb-modular#174', 'rtdb-modular#M93',
      ],
      description:
        'Reference navigation/string shape, ref/child/refFromURL validation, forged-reference failure timing, and a successful normal read control.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'reference-shape-url', attempt);
        const client = await createClient(ctx, `reference-shape-url-${attempt}`);
        const otherClient = await createClient(ctx, `reference-shape-url-other-${attempt}`);
        try {
          const root = ref(client.db);
          const nested = ref(client.db, `${path}/parent/child`);
          const viaChild = child(ref(client.db, `${path}/parent`), 'child');
          await set(nested, { ok: true });
          const matchingUrl = `${ctx.config.databaseURL.replace(/\/$/, '')}/${path}/parent/child`;
          const matching = refFromURL(client.db, matchingUrl);
          const otherHost = new URL(ctx.config.databaseURL);
          otherHost.hostname = `other-${otherHost.hostname}`;
          otherHost.pathname = `/${path}/parent/child`;
          const constrained = query(nested, orderByValue(), startAt(1), endAt(2));
          const equivalent = query(nested, endAt(2), orderByValue(), startAt(1));
          const invalidPathCharacters = ['.', '#', '$', '[', ']'];
          const ftpReference = refFromURL(
            client.db,
            `ftp://${new URL(ctx.config.databaseURL).hostname}/${path}/ftp-child`,
          );
          const queryReference = refFromURL(
            client.db,
            `${ctx.config.databaseURL.replace(/\/$/, '')}/${path}/query-child?ignored=true`,
          );
          return {
            root: {
              key: root.key,
              parent: root.parent,
              rootKey: root.root.key,
              toString: referenceStringShape(root.toString(), '/'),
            },
            nested: {
              key: nested.key,
              parentKey: nested.parent?.key ?? null,
              rootKey: nested.root.key,
              toString: referenceStringShape(nested.toString(), `${path}/parent/child`),
              childToStringMatches: viaChild.toString() === nested.toString(),
            },
            queryIdentity: {
              referenceToJSON: referenceStringShape(nested.toJSON(), `${path}/parent/child`),
              queryToJSON: referenceStringShape(constrained.toJSON(), `${path}/parent/child`),
              sameReference: nested.isEqual(viaChild),
              defaultQueryEqualsReference: nested.isEqual(query(nested)),
              referenceEqualsDefaultQuery: query(nested).isEqual(nested),
              equivalentConstraintOrder: constrained.isEqual(equivalent),
              differentSpec: constrained.isEqual(query(nested, orderByValue(), startAt(2))),
              differentPath: nested.isEqual(ref(client.db, `${path}/other`)),
              differentApp: nested.isEqual(ref(otherClient.db, `${path}/parent/child`)),
              nullValue: nested.isEqual(null),
              nonQuery: nested.isEqual({} as never),
            },
            referenceValidation: {
              invalidRefPaths: await Promise.all(invalidPathCharacters.map((character) =>
                captureInvocation(() => ref(client.db, `bad${character}path`)))),
              invalidChildPath: await captureInvocation(() => child(root, 'bad#path')),
              emptyChildPath: await captureInvocation(() => child(root, '')),
              fragmentUrl: await captureInvocation(() => refFromURL(
                client.db,
                `${ctx.config.databaseURL.replace(/\/$/, '')}/${path}/fragment#bad`,
              )),
              ftpUrl: referenceStringShape(ftpReference.toString(), `${path}/ftp-child`),
              queryUrl: referenceStringShape(queryReference.toString(), `${path}/query-child`),
            },
            matchingUrl: {
              key: matching.key,
              value: (await get(matching)).val(),
              toString: referenceStringShape(matching.toString(), `${path}/parent/child`),
            },
            mismatchedHost: await captureInvocation(() => refFromURL(client.db, otherHost.toString())),
            malformedUrl: await captureInvocation(() => refFromURL(client.db, 'not-an-absolute-url')),
            forgedReference: await captureInvocation(() => get({} as never)),
            terminal: await adminRead(ctx, path),
          };
        } finally {
          await cleanup([() => client.close(), () => otherClient.close(), () => adminRemove(ctx, path)]);
        }
      }),
    };
}
