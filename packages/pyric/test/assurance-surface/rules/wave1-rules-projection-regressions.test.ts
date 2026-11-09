import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setRtdbRules } from 'pyric/sandbox/database';
import { getDatabase, onDisconnect, push, ref, set, update } from 'pyric/database';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';
import { crossServiceLookupSeeds, lookupSeeds } from '../../../src/assurance-surface/probes/prerequisites.js';
import { planProbes } from '../../../src/assurance-surface/probes/plan.js';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import { synthesizeMatchingContentType } from '../../../src/assurance-surface/probes/storage-step-builder.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import {
  firestoreRequiredClaims,
  rtdbRequiredClaims,
  storageRequiredClaims,
} from '../../../src/assurance-surface/rules/claims.js';
import { firestoreOwnerConditions } from '../../../src/assurance-surface/rules/firestore-owners.js';
import { rtdbOwnerConditions } from '../../../src/assurance-surface/rules/rtdb-owners.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { storageOwnerConditions, storageValueHints } from '../../../src/assurance-surface/rules/storage-owners.js';
import { firestoreValueHints, rtdbValueHints } from '../../../src/assurance-surface/rules/value-hints.js';

describe('rules projection, hint, and claim extraction regressions', () => {
  describe('lexical declaration scope during helper function inlining', () => {
    test('resolves nested helper calls against declaration-site functions in Firestore and Storage', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function gate() { return true; }
          function canRead() { return gate(); }
          function isCallerUid(candidate) { return candidate == request.auth.uid; }
          function matchesOwner(candidate) { return isCallerUid(candidate); }
          function isOpenStatus(val) { return val == 'open'; }
          function validStatus() { return isOpenStatus(request.resource.data.status); }
          match /databases/{db}/documents {
            match /items/{id} {
              function gate() { return false; }
              function isCallerUid(candidate) { return false; }
              function isOpenStatus(val) { return val == 'closed'; }
              allow get: if canRead() && matchesOwner(resource.data.ownerId);
              allow create: if validStatus();
            }
          }
        }
      `;

      const stRules = `
        rules_version = '2';
        service firebase.storage {
          function withinCap(n) { return n <= 1024; }
          function checkUpload() { return withinCap(request.resource.size); }
          match /b/{bucket}/o {
            match /items/{id} {
              function withinCap(n) { return n <= 1; }
              allow write: if checkUpload();
            }
          }
        }
      `;

      const surface = projectRuleSurface({ firestore: fsRules, storage: stRules });
      const fsMatches = surface.matching(parseResourcePattern('firestore', 'items/a'), 'get');
      expect(fsMatches).toHaveLength(1);
      expect(fsMatches[0]!.alwaysDeny).toBeUndefined();

      const owners = firestoreOwnerConditions(fsRules, 'firestore.rules');
      expect(owners).toEqual([
        expect.objectContaining({
          path: 'items/{id}',
          kind: 'storedField',
          field: 'ownerId',
          relation: 'equals',
        }),
      ]);

      const hints = firestoreValueHints(fsRules);
      expect(hints).toEqual([
        {
          service: 'firestore',
          path: 'items/{id}',
          field: 'status',
          value: 'open',
        },
      ]);

      const stMatches = surface.matching(parseResourcePattern('storage', 'items/a'), 'write');
      expect(stMatches).toHaveLength(1);
      expect(stMatches[0]!.storageMetadata?.maxSizeBytes).toBe(1024);
    });

    test('does not leak caller match wildcards into outer-scope helper functions', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function matchesUid() { return request.auth.uid == uid; }
          match /databases/{db}/documents {
            match /users/{uid} {
              allow get: if matchesUid();
            }
          }
        }
      `;

      const owners = firestoreOwnerConditions(fsRules, 'firestore.rules');
      expect(owners).toEqual([]);
    });
  });

  describe('RTDB $wildcard sibling exclusions and .validate: false writes', () => {
    test('excludes literal sibling keys when matching RTDB $wildcard rules including descendants', () => {
      const siblingRules = {
        rules: {
          items: {
            $id: { '.read': true, '.write': true },
            reserved: { '.validate': 'newData.isString()' },
          },
        },
      };

      const surface = projectRuleSurface({ rtdb: siblingRules });
      expect(surface.matching(parseResourcePattern('rtdb', 'items/a'), 'get')).toHaveLength(1);
      expect(surface.matching(parseResourcePattern('rtdb', 'items/reserved'), 'get')).toHaveLength(0);
      expect(surface.matching(parseResourcePattern('rtdb', 'items/reserved'), 'set')).toHaveLength(0);
      expect(surface.matching(parseResourcePattern('rtdb', 'items/reserved/child'), 'get')).toHaveLength(0);
      expect(surface.matching(parseResourcePattern('rtdb', 'items/$dyn'), 'get')).toHaveLength(1);
    });

    test('treats self and ancestor .validate: false as denying non-delete writes while allowing remove and set(null)', () => {
      const validateFalseRules = {
        rules: {
          docs: {
            $docId: { '.read': true, '.write': true, '.validate': false },
          },
          ancestorBlocked: {
            '.validate': false,
            $docId: { '.read': true, '.write': true },
          },
        },
      };

      const usage = extractSdkUsage({
        root: '/project',
        files: {
          'src/app.ts': `
            import { initializeApp } from 'firebase/app';
            import { getDatabase, ref, get, set, push, update, remove } from 'firebase/database';
            const db = getDatabase(initializeApp({}));
            export const readDoc = () => get(ref(db, 'docs/d1'));
            export const setDocVal = () => set(ref(db, 'docs/d1'), { v: 1 });
            export const pushDocVal = () => push(ref(db, 'docs'), { v: 1 });
            export const updateDocVal = () => update(ref(db, 'docs/d1'), { v: 1 });
            export const removeDoc = () => remove(ref(db, 'docs/d1'));
            export const setDocNull = () => set(ref(db, 'docs/d1'), null);
            export const setAncestorBlocked = () => set(ref(db, 'ancestorBlocked/d1'), { v: 1 });
            export const removeAncestorBlocked = () => remove(ref(db, 'ancestorBlocked/d1'));
          `,
        },
      });

      const diagnostics = coverageMatrixPass(usage, { rtdb: validateFalseRules });
      const uncovered = diagnostics.filter(
        (d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof',
      );
      expect(
        uncovered
          .map((d) => `${d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `$${s.name}`)).join('/')}:${d.message.match(/'([^']+)' on '/)?.[1]}`)
          .sort(),
      ).toEqual([
        'ancestorBlocked/d1:set',
        'docs/$pushId:push',
        'docs/d1:set',
        'docs/d1:update',
      ]);
    });

    test('does not emit static-proof .validate: false denials on empty, null-evaporating, optional, or dynamic RTDB payloads while still enforcing .write coverage', async () => {
      const validateFalseRules = {
        rules: {
          docs: {
            $docId: { '.read': true, '.write': true, '.validate': false },
          },
        },
      };

      const sb = initializeSandbox();
      setRtdbRules(sb, validateFalseRules);
      const db = getDatabase(sb.withAuth({ uid: 'u-alice' }));
      await update(ref(db, 'docs/d1'), {});
      await onDisconnect(ref(db, 'docs/d1')).update({});
      await update(ref(db, 'docs/d1'), { a: null });
      await onDisconnect(ref(db, 'docs/d1')).update({ a: null });
      await set(ref(db, 'docs/d1'), {});
      await set(ref(db, 'docs/d1'), { a: null });
      await set(ref(db, 'docs/d1'), { a: {} });
      await set(ref(db, 'docs/d1'), []);
      await onDisconnect(ref(db, 'docs/d1')).set({});
      await push(ref(db, 'docs'), null);
      await push(ref(db, 'docs'), {});

      const usage = extractSdkUsage({
        root: '/project',
        files: {
          'src/app.ts': `
            import { initializeApp } from 'firebase/app';
            import { getDatabase, onDisconnect, push, ref, serverTimestamp, set, update } from 'firebase/database';
            const db = getDatabase(initializeApp({}));
            export const updEmpty = () => update(ref(db, 'docs/d1'), {});
            export const discUpdEmpty = () => onDisconnect(ref(db, 'docs/d1')).update({});
            export const updChildNull = () => update(ref(db, 'docs/d1'), { a: null });
            export const discUpdChildNull = () => onDisconnect(ref(db, 'docs/d1')).update({ a: null });
            export const setEmptyObj = () => set(ref(db, 'docs/d1'), {});
            export const setAllNullObj = () => set(ref(db, 'docs/d1'), { a: null });
            export const setNestedEmptyObj = () => set(ref(db, 'docs/d1'), { a: {} });
            export const setEmptyArr = () => set(ref(db, 'docs/d1'), []);
            export const discSetEmpty = () => onDisconnect(ref(db, 'docs/d1')).set({});
            export const pushNull = () => push(ref(db, 'docs'), null);
            export const pushEmpty = () => push(ref(db, 'docs'), {});
            export const setDynamic = (val: unknown) => set(ref(db, 'docs/d1'), val);
            export const updDynamic = (patch: Record<string, unknown>) => update(ref(db, 'docs/d1'), patch);
            export const updOptionalOnly = (cond: boolean) => update(ref(db, 'docs/d1'), { ...(cond ? { a: 1 } : {}) });
            export const setNestedLeaf = () => set(ref(db, 'docs/d2'), { a: { b: 1 } });
            export const setSentinel = () => set(ref(db, 'docs/d3'), serverTimestamp());
            export const discSetNonNull = () => onDisconnect(ref(db, 'docs/d4')).set({ online: false });
            export const discUpdNonNull = () => onDisconnect(ref(db, 'docs/d5')).update({ online: false });
            export const setUnmatchedEmpty = () => set(ref(db, 'unmatched/d1'), {});
          `,
        },
      });

      const diagnostics = coverageMatrixPass(usage, { rtdb: validateFalseRules });
      const uncovered = diagnostics.filter(
        (d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof',
      );
      expect(
        uncovered
          .map((d) => `${d.resource.segments.map((s) => (s.kind === 'lit' ? s.text : `$${s.name}`)).join('/')}:${d.message.match(/'([^']+)' on '/)?.[1]}`)
          .sort(),
      ).toEqual([
        'docs/d2:set',
        'docs/d3:set',
        'docs/d4:onDisconnect.set',
        'docs/d5:onDisconnect.update',
        'unmatched/d1:set',
      ]);
    });
  });

  describe('Firestore header validation and concrete resourceId isolation', () => {
    test('ignores Firestore match blocks without /databases/{db}/documents and root documents allows', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            allow read, write: if true;
            match /docs/{docId} {
              allow read: if true;
            }
          }
          match /items/{id} {
            allow read, write: if request.auth != null;
          }
        }
      `;

      const surface = projectRuleSurface({ firestore: fsRules });
      expect(surface.matching(parseResourcePattern('firestore', 'docs/d1'), 'get')).toHaveLength(1);
      expect(surface.matching(parseResourcePattern('firestore', 'items/a'), 'get')).toHaveLength(0);
      expect(surface.entries.map((e) => e.pattern.segments.map((s) => (s.kind === 'lit' ? s.text : `{${s.name}}`)).join('/'))).toEqual([
        'docs/{docId}',
      ]);
    });

    test('prevents concrete Storage bucket and Firestore database headers from bleeding across configured targets', () => {
      const wrongHeaderBucketA = `
        rules_version = '2';
        service firebase.storage {
          match /b/bucket-b/o {
            match /items/{id} { allow read, write: if request.auth != null; }
          }
        }
      `;
      const denyAllBucketB = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /{allPaths=**} { allow read, write: if false; }
          }
        }
      `;
      const wrongHeaderDbA = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/db-b/documents {
            match /items/{id} { allow read: if true; }
          }
        }
      `;
      const denyAllDbB = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            match /items/{id} { allow read: if false; }
          }
        }
      `;

      const surface = projectRuleSurface({
        storage: [
          { bucket: 'bucket-a', text: wrongHeaderBucketA, source: 'a.rules' },
          { bucket: 'bucket-b', text: denyAllBucketB, source: 'b.rules' },
        ],
        firestore: [
          { databaseId: 'db-a', text: wrongHeaderDbA, source: 'db-a.rules' },
          { databaseId: 'db-b', text: denyAllDbB, source: 'db-b.rules' },
        ],
      });

      const matchA = surface.matching(parseResourcePattern('storage', 'items/1', 'bucket-a'), 'write');
      expect(matchA).toHaveLength(0);

      const matchB = surface.matching(parseResourcePattern('storage', 'items/1', 'bucket-b'), 'write');
      expect(matchB).toHaveLength(1);
      expect(matchB[0]!.alwaysDeny).toBe(true);

      const fsMatchA = surface.matching(parseResourcePattern('firestore', 'items/1', 'db-a'), 'get');
      expect(fsMatchA).toHaveLength(0);

      const fsMatchB = surface.matching(parseResourcePattern('firestore', 'items/1', 'db-b'), 'get');
      expect(fsMatchB).toHaveLength(1);
      expect(fsMatchB[0]!.alwaysDeny).toBe(true);
    });
  });

  describe('helper calls in operand and argument positions and update setup synthesis', () => {
    test('inlines helper functions in Storage cross-service paths, size/contentType constraints, and owner helpers', () => {
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          function itemDoc(id) { return /databases/(default)/documents/items/$(id); }
          function maxBytes() { return 100; }
          function allowedMime() { return 'image/.*'; }
          function currentUid() { return request.auth.uid; }
          match /b/{bucket}/o {
            match /users/{uid}/items/{id} {
              allow write: if request.auth != null
                && uid == currentUid()
                && request.resource.metadata.ownerId == currentUid()
                && firestore.exists(itemDoc(id))
                && request.resource.size <= 2 * maxBytes()
                && request.resource.contentType.matches(allowedMime());
            }
          }
        }
      `;

      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function currentUid() { return request.auth.uid; }
          function hasAnyUid(list, uids) { return list.hasAny(uids); }
          match /databases/{db}/documents {
            match /items/{id} {
              allow read, update: if request.auth != null
                && resource.data.ownerId == currentUid()
                && hasAnyUid(resource.data.members, [request.auth.uid]);
            }
          }
        }
      `;

      const surface = projectRuleSurface({ storage: stRules, firestore: fsRules });
      const stMatches = surface.matching(parseResourcePattern('storage', 'users/u1/items/i1'), 'write');
      expect(stMatches).toHaveLength(1);
      expect(stMatches[0]!.crossServiceReads).toEqual([
        {
          targetService: 'firestore',
          kind: 'exists',
          pattern: parseResourcePattern('firestore', 'items/{id}'),
        },
      ]);
      expect(stMatches[0]!.storageMetadata).toEqual({
        maxSizeBytes: 200,
        contentTypePattern: 'image/.*',
        ownerMetadataKey: 'ownerId',
        requiredCustomMetadataKeys: ['ownerId'],
      });
      expect(stMatches[0]!.ownerConditions.map((c) => `${c.kind}:${c.field}:${c.relation}`).sort()).toEqual([
        'incomingField:ownerId:equals',
        'pathVar:{uid}:equals',
      ]);

      const fsMatches = surface.matching(parseResourcePattern('firestore', 'items/i1'), 'update');
      expect(fsMatches).toHaveLength(1);
      expect(fsMatches[0]!.ownerConditions.map((c) => `${c.kind}:${c.field}:${c.relation}`).sort()).toEqual([
        'storedField:members:contains',
        'storedField:ownerId:equals',
      ]);
    });

    test('synthesizes setup initializer fields for standalone update fallbacks without clobbering explicit payloads or genuine creators', async () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function currentUid() { return request.auth.uid; }
          function hasAnyUid(list, uids) { return list.hasAny(uids); }
          match /databases/{db}/documents {
            match /items/{id} {
              allow create: if request.auth != null;
              allow read, update: if request.auth != null
                && resource.data.ownerId == currentUid()
                && hasAnyUid(resource.data.members, [request.auth.uid])
                && request.auth.uid in resource.data.acl.keys()
                && resource.data.meta.authorId == currentUid();
            }
          }
        }
      `;
      const conditions = firestoreOwnerConditions(fsRules, 'firestore.rules');
      const owner = { role: 'owner' as const, uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice', token: {} };
      const peer = { role: 'peer' as const, uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob', token: {} };

      const standaloneUpdate = {
        service: 'firestore' as const,
        op: 'updateDoc' as const,
        path: 'items/i1',
        source: 'src/app.ts:10',
        resolution: 'resolved' as const,
        payload: {
          kind: 'object' as const,
          open: false,
          fields: [
            { name: 'title', kind: 'string' as const, literal: 'next' },
            { name: 'meta', kind: 'object' as const },
            { name: 'meta.label', kind: 'string' as const, literal: 'kept' },
          ],
        },
      };

      const standaloneProbes = planProbes({
        sites: [standaloneUpdate],
        bindings: inferOwnerBindings(conditions, [standaloneUpdate]),
        conditions,
        owner,
        peer,
      });
      const updateMustAllow = standaloneProbes.find((p) => p.kind === 'must-allow-denied' && p.op === 'update');
      expect(updateMustAllow?.inconclusiveOnDeny).toBe('client update may be missing initializer fields required by rules');
      expect(updateMustAllow?.setup).toEqual([
        {
          actor: 'owner',
          service: 'firestore',
          method: 'set',
          path: 'items/i1',
          data: {
            title: 'next',
            ownerId: 'u-alice',
            members: ['u-alice'],
            acl: { 'u-alice': true },
            meta: { label: 'kept', authorId: 'u-alice' },
          },
        },
      ]);

      const genuineCreator = {
        service: 'firestore' as const,
        op: 'setDoc' as const,
        path: 'items/i1',
        source: 'src/app.ts:4',
        resolution: 'resolved' as const,
        payload: {
          kind: 'object' as const,
          open: false,
          fields: [{ name: 'title', kind: 'string' as const, literal: 'created' }],
        },
      };
      const pairedProbes = planProbes({
        sites: [genuineCreator, standaloneUpdate],
        bindings: inferOwnerBindings(conditions, [genuineCreator, standaloneUpdate]),
        conditions,
        owner,
        peer,
      });
      const pairedUpdate = pairedProbes.find((p) => p.kind === 'must-allow-denied' && p.op === 'update');
      expect(pairedUpdate?.inconclusiveOnDeny).toBeUndefined();
      expect(pairedUpdate?.setup).toEqual([
        {
          actor: 'owner',
          service: 'firestore',
          method: 'set',
          path: 'items/i1',
          data: { title: 'created' },
        },
      ]);

      const e2eSources = {
        firestore: [{ source: 'firestore.rules', text: fsRules }],
        rtdb: [],
        problems: [],
      };
      const report = await runProbes({
        accessSites: [standaloneUpdate],
        ownerBindings: inferOwnerBindings(conditions, [standaloneUpdate]),
        conditions,
        sources: e2eSources,
      });
      expect(report.probes.invalid).toBe(0);
      expect(report.findings.filter((f) => f.kind === 'must-allow-denied')).toEqual([]);

      const rtdbConditions = rtdbOwnerConditions(
        {
          rules: {
            items: {
              $id: {
                '.write':
                  "auth != null && (data.val() == null || (data.child('ownerId').val() == auth.uid && data.child('acl').hasChild(auth.uid) && data.child('meta/editorId').val() == auth.uid))",
              },
            },
          },
        },
        'database.rules.json',
      );
      const rtdbStandaloneUpdate = {
        service: 'rtdb' as const,
        op: 'update' as const,
        path: 'items/$id',
        pathVariables: [{ name: 'id' }],
        source: 'src/rtdb.ts:8',
        resolution: 'resolved' as const,
        payload: {
          kind: 'object' as const,
          open: false,
          fields: [
            { name: 'ownerId', kind: 'string' as const, literal: 'explicit-owner' },
            { name: 'title', kind: 'string' as const, literal: 'edited' },
          ],
        },
      };
      const rtdbProbes = planProbes({
        sites: [rtdbStandaloneUpdate],
        bindings: inferOwnerBindings(rtdbConditions, [rtdbStandaloneUpdate]),
        conditions: rtdbConditions,
        owner,
        peer,
      });
      const rtdbMustAllow = rtdbProbes.find((p) => p.kind === 'must-allow-denied' && p.op === 'update');
      expect(rtdbMustAllow?.setup).toEqual([
        {
          actor: 'owner',
          service: 'rtdb',
          method: 'update',
          path: 'items/v-id',
          data: {
            ownerId: 'explicit-owner',
            title: 'edited',
            acl: { 'u-alice': true },
            meta: { editorId: 'u-alice' },
          },
        },
      ]);
    });
  });

  describe('Storage firestore.get() list/numeric hints and default-DB enforcement', () => {
    test('populates list and relational hints for .hasAny/.hasAll, literal-in-list, and numeric bounds', () => {
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /users/{uid}/items/{id} {
              allow read, write: if request.auth != null
                && request.auth.uid == uid
                && firestore.get(/databases/(default)/documents/items/$(id)).data.viewers.hasAny([request.auth.uid])
                && firestore.get(/databases/(default)/documents/items/$(id)).data.tags.hasAll(['alpha', 'beta'])
                && 'editor' in firestore.get(/databases/(default)/documents/items/$(id)).data.roles
                && firestore.get(/databases/(default)/documents/items/$(id)).data.quota > 0
                && firestore.get(/databases/(default)/documents/items/$(id)).data.used < 5;
            }
          }
        }
      `;

      const surface = projectRuleSurface({ storage: stRules });
      const entry = surface.entries[0]!;
      const seeds = crossServiceLookupSeeds({
        storageTemplate: 'users/{uid}/items/{id}',
        rulePattern: entry.pattern,
        concreteStoragePath: 'users/u1/items/i1',
        lookups: entry.crossServiceReads,
        actors: [{ name: 'owner', uid: 'u1', token: {} }],
      });

      expect(seeds).toEqual([
        {
          actor: 'admin',
          service: 'firestore',
          method: 'set',
          path: 'items/i1',
          data: {
            viewers: ['u1'],
            tags: ['alpha', 'beta'],
            roles: ['editor'],
            quota: 1,
            used: 4,
          },
        },
      ]);
    });

    test('rejects non-(default) Firestore database paths in Storage cross-service lookups', () => {
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /items/{id} {
              allow read, write: if request.auth != null
                && firestore.exists(/databases/secondary-db/documents/users/$(request.auth.uid))
                && firestore.get(/databases/secondary-db/documents/items/$(id)).data.active == true;
            }
          }
        }
      `;

      const surface = projectRuleSurface({ storage: stRules });
      expect(surface.entries[0]!.crossServiceReads).toEqual([]);
    });
  });

  describe('ternary guard/negation polarity and RTDB numeric lookup seeds', () => {
    test('flips polarity on ternary conditions with false consequents in Firestore, RTDB, and Storage value hints', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            match /users/{uid} {
              allow read, write: if request.auth != null
                && (('status' in request.resource.data && request.resource.data.status == 'locked') ? false : true)
                && (request.resource.data.tier != 'standard' ? false : true);
            }
          }
        }
      `;
      const rtdbRules = {
        rules: {
          users: {
            $uid: {
              '.write': 'auth != null',
              '.validate': "(newData.child('status').val() == 'locked' ? false : true) && (newData.child('tier').val() != 'standard' ? false : true)",
            },
          },
        },
      };
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /users/{uid}/items/{id} {
              allow write: if request.auth != null
                && request.auth.uid == uid
                && (('status' in request.resource.metadata && request.resource.metadata.status == 'locked') ? false : true)
                && (request.resource.metadata.tier != 'standard' ? false : true);
            }
          }
        }
      `;

      expect(firestoreValueHints(fsRules)).toEqual([
        { service: 'firestore', path: 'users/{uid}', field: 'tier', value: 'standard' },
      ]);
      expect(rtdbValueHints(rtdbRules)).toEqual([
        { service: 'rtdb', path: 'users/$uid', field: 'tier', value: 'standard' },
      ]);
      expect(storageValueHints(stRules)).toEqual([
        { service: 'storage', path: 'users/{uid}/items/{id}', field: 'tier', value: 'standard', wildcardBucket: true },
      ]);
    });

    test('preserves effective polarity on negated ternary guards in Firestore, RTDB, and Storage owner conditions', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            match /items/{id} {
              allow read, write: if request.auth != null
                && !(request.auth.uid != request.resource.data.reviewerId ? false : true)
                && !(request.auth.uid == request.resource.data.ownerId ? false : true);
            }
          }
        }
      `;
      const rtdbRules = {
        rules: {
          items: {
            $id: {
              '.write': "auth != null && !(auth.uid != newData.child('reviewerId').val() ? false : true) && !(auth.uid == newData.child('ownerId').val() ? false : true)",
            },
          },
        },
      };
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /items/{id} {
              allow write: if request.auth != null
                && !(request.auth.uid != request.resource.metadata.reviewerId ? false : true)
                && !(request.auth.uid == request.resource.metadata.ownerId ? false : true);
            }
          }
        }
      `;

      expect(firestoreOwnerConditions(fsRules, 'firestore.rules').map((c) => `${c.field}:${c.relation}:${c.required}`)).toEqual([
        'ownerId:equals:true',
      ]);
      expect(rtdbOwnerConditions(rtdbRules, 'database.rules.json').map((c) => `${c.field}:${c.relation}:${c.required}`)).toEqual([
        'ownerId:equals:true',
      ]);
      expect(storageOwnerConditions(stRules, 'storage.rules').map((c) => `${c.field}:${c.relation}:${c.required}`)).toEqual([
        'ownerId:equals:true',
      ]);
    });

    test('seeds satisfying numeric values for RTDB <, <=, >, >= root.child(auth.uid) lookups', () => {
      const rtdbRules = {
        rules: {
          users: {
            $uid: {
              '.write':
                "auth != null && auth.uid === $uid && (root.child('items').child(auth.uid).val() == null || root.child('items').child(auth.uid).val() < 5) && root.child('quotas').child(auth.uid).val() != null && root.child('quotas').child(auth.uid).val() > 0",
            },
          },
        },
      };

      const conditions = rtdbOwnerConditions(rtdbRules, 'database.rules.json');
      const seeds = lookupSeeds(
        'rtdb',
        'users/$uid',
        'users/u1',
        conditions,
        [],
        [{ name: 'owner', uid: 'u1', token: {} }],
      );

      expect(seeds).toEqual([
        { actor: 'admin', service: 'rtdb', method: 'set', path: 'items/u1', data: 4 },
        { actor: 'admin', service: 'rtdb', method: 'set', path: 'quotas/u1', data: 1 },
      ]);
    });
  });

  describe('multi-match claim scope isolation, parameterized helpers, and ! negation', () => {
    test('isolates local functions across sibling root match /databases/{db}/documents blocks', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function checkRole() { return request.auth.token.role == 'viewer'; }
          match /databases/{db}/documents {
            function checkRole() { return request.auth.token.role == 'admin'; }
            match /docs/{docId} {
              allow read: if checkRole();
            }
          }
          match /databases/{db}/documents {
            match /users/{uid} {
              allow read, write: if request.auth != null && request.auth.uid == uid && checkRole();
            }
          }
        }
      `;

      expect(firestoreRequiredClaims(fsRules, { path: 'docs/d1', op: 'get' })).toEqual({ role: 'admin' });
      expect(firestoreRequiredClaims(fsRules, { path: 'users/u1', op: 'set' })).toEqual({ role: 'viewer' });
    });

    test('inlines parameterized claim helpers in Firestore and Storage without capturing caller wildcards', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          function editorLiteral() { return 'editor'; }
          function hasRole(r) {
            let docId = 'admin';
            return request.auth.token.role == r;
          }
          match /databases/{db}/documents {
            match /users/{uid} {
              allow read, write: if request.auth != null && request.auth.uid == uid && hasRole(editorLiteral());
            }
            match /docs/{docId} {
              allow read: if hasRole(docId);
            }
          }
        }
      `;
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          function hasTier(t) { return request.auth.token.tier == t; }
          match /b/{bucket}/o {
            match /items/{id} {
              allow write: if request.auth != null && hasTier('pro');
            }
          }
        }
      `;

      expect(firestoreRequiredClaims(fsRules, { path: 'users/u1', op: 'set' })).toEqual({ role: 'editor' });
      expect(firestoreRequiredClaims(fsRules, { path: 'docs/d1', op: 'get' })).toEqual({});
      expect(storageRequiredClaims(stRules, { path: 'items/i1', op: 'create' })).toEqual({ tier: 'pro' });
    });

    test('evaluates unary ! negations, De Morgan laws, and negated bare claims across Firestore, Storage, and RTDB', () => {
      const fsRules = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{db}/documents {
            match /users/{uid} {
              allow read, write: if request.auth != null
                && request.auth.uid == uid
                && !(request.auth.token.role != 'editor')
                && !(request.auth.token.hasAccess == null)
                && !request.auth.token.suspended
                && !(request.auth.token.banned == true);
            }
          }
        }
      `;
      const stRules = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /users/{uid}/items/{id} {
              allow write: if request.auth != null
                && request.auth.uid == uid
                && !(request.auth.token.role != 'editor' || request.auth.token.org != 'acme')
                && !request.auth.token.suspended;
            }
          }
        }
      `;
      const rtdbRules = {
        rules: {
          users: {
            $uid: {
              '.write': "auth != null && auth.uid === $uid && !(auth.token.role !== 'editor') && !auth.token.suspended",
            },
          },
        },
      };

      expect(firestoreRequiredClaims(fsRules, { path: 'users/u1', op: 'set' })).toEqual({
        role: 'editor',
        hasAccess: true,
      });
      expect(storageRequiredClaims(stRules, { path: 'users/u1/items/i1', op: 'create' })).toEqual({
        role: 'editor',
        org: 'acme',
      });
      expect(rtdbRequiredClaims(rtdbRules, { path: 'users/u1', op: 'create' })).toEqual({
        role: 'editor',
      });
    });
  });

  describe('commutative contentType regex conjunction in Storage constraints', () => {
    test('retains all contentType regex constraints under && regardless of operand order or ^...$ anchoring', () => {
      const orderAB = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /items/{id} {
              allow write: if request.resource.contentType.matches('image/.*')
                && request.resource.contentType.matches('.*png');
            }
          }
        }
      `;
      const orderBA = `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /items/{id} {
              allow write: if request.resource.contentType.matches('.*png')
                && request.resource.contentType.matches('image/.*');
            }
          }
        }
      `;

      const usage = extractSdkUsage({
        root: '/project',
        files: {
          'src/app.ts': `
            import { initializeApp } from 'firebase/app';
            import { getStorage, ref, uploadBytes } from 'firebase/storage';
            const st = getStorage(initializeApp({}));
            export const upBad = () => uploadBytes(ref(st, 'items/1'), new Uint8Array([1]), { contentType: 'image/jpeg' });
            export const upGood = () => uploadBytes(ref(st, 'items/2'), new Uint8Array([1]), { contentType: 'image/png' });
          `,
        },
      });

      const diagsAB = storageContractPass(usage, orderAB).filter(
        (d) => d.code === 'storage-content-type-mismatch' && d.certainty === 'static-proof',
      );
      const diagsBA = storageContractPass(usage, orderBA).filter(
        (d) => d.code === 'storage-content-type-mismatch' && d.certainty === 'static-proof',
      );
      expect(diagsAB).toHaveLength(1);
      expect(diagsBA).toHaveLength(1);

      const patAB = projectRuleSurface({ storage: orderAB }).entries[0]!.storageMetadata?.contentTypePattern;
      const patBA = projectRuleSurface({ storage: orderBA }).entries[0]!.storageMetadata?.contentTypePattern;
      expect(synthesizeMatchingContentType(patAB)).toBe('image/png');
      expect(synthesizeMatchingContentType(patBA)).toBe('image/png');
    });
  });
});
