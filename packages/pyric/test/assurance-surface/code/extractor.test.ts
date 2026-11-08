import { describe, expect, test } from 'bun:test';
import { extractAccessSites } from '../../../src/assurance-surface/code/extractor.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';

const ROOT = '/virtual/app';

function sites(files: Record<string, string>): AccessSite[] {
  return extractAccessSites({ root: ROOT, files }).accessSites;
}

function brief(list: AccessSite[]): string[] {
  return list.map((s) => `${s.source} ${s.op} ${s.path} ${s.resolution}`);
}

describe('extractAccessSites: Firestore', () => {
  test('literal and template paths, with payload auth provenance', () => {
    const out = sites({
      'src/db.ts': `
        import { getFirestore, doc, setDoc, collection, addDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
        import { getAuth } from 'firebase/auth';
        const db = getFirestore();
        const auth = getAuth();
        export async function post(roomId: string, text: string) {
          await addDoc(collection(db, 'rooms', roomId, 'messages'), {
            text,
            author: auth.currentUser!.uid,
            createdAt: serverTimestamp(),
          });
        }
        export const rename = (roomId: string, name: string) => setDoc(doc(db, \`rooms/\${roomId}\`), { name }, { merge: true });
        export const like = (roomId: string, id: string) => updateDoc(doc(db, 'rooms', roomId, 'messages', id), 'likes', 1);
        export const drop = (roomId: string) => deleteDoc(doc(db, 'rooms', roomId));
      `,
    });
    expect(brief(out)).toEqual([
      'src/db.ts:7 addDoc rooms/{roomId}/messages/{autoId} resolved',
      'src/db.ts:13 setDoc rooms/{roomId} resolved',
      'src/db.ts:14 updateDoc rooms/{roomId}/messages/{id} resolved',
      'src/db.ts:15 deleteDoc rooms/{roomId} resolved',
    ]);
    const add = out[0];
    expect(add.payload?.fields).toEqual([
      { name: 'text', kind: 'unknown' },
      { name: 'author', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
      { name: 'createdAt', kind: 'serverTimestamp' },
    ]);
    expect(out[1].payload?.merge).toBe(true);
    expect(out[2].payload?.fields).toEqual([{ name: 'likes', kind: 'number', literal: 1 }]);
  });

  test('batch and transaction writes carry `via`', () => {
    const out = sites({
      'a.ts': `
        import { getFirestore, doc, writeBatch, runTransaction } from 'firebase/firestore';
        const db = getFirestore();
        export async function move(id: string) {
          const batch = writeBatch(db);
          batch.set(doc(db, 'archive', id), { id });
          batch.delete(doc(db, 'live', id));
          await batch.commit();
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(doc(db, 'counters', 'c'));
            tx.update(doc(db, 'counters', 'c'), { n: 1 });
          });
        }
      `,
    });
    expect(out.map((s) => `${s.op}:${s.via ?? ''}:${s.path}`)).toEqual([
      'setDoc:batch:archive/{id}',
      'deleteDoc:batch:live/{id}',
      'get:transaction:counters/c',
      'updateDoc:transaction:counters/c',
    ]);
  });

  test('an inline query passed straight to getDocs is reported, with its constraints', () => {
    const out = sites({
      'inline.ts': `
        import { collectionGroup, getDocs, orderBy, query, where } from 'firebase/firestore';
        import { db } from './db';
        export async function recentProjects(ownerId: string) {
          return getDocs(query(collectionGroup(db, 'projects'), where('ownerId', '==', ownerId), orderBy('updatedAt', 'desc')));
        }
      `,
      'db.ts': `import { getFirestore } from 'firebase/firestore'; export const db = getFirestore();`,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      op: 'query',
      path: '{path=**}/projects',
      source: 'inline.ts:5',
      resolution: 'resolved',
      query: [
        { kind: 'where', field: 'ownerId', op: '==' },
        { kind: 'orderBy', field: 'updatedAt', direction: 'desc' },
      ],
    });
  });

  test('a query handed to a hook outside the project is listed as unresolved, not dropped', () => {
    const out = sites({
      'list.tsx': `
        import { collection, query, where } from 'firebase/firestore';
        import { useCollection } from 'react-firebase-hooks/firestore';
        import { db } from './db';
        export function Todos({ uid }: { uid: string }) {
          const [snap] = useCollection(query(collection(db, 'todos'), where('owner', '==', uid)));
          return null;
        }
      `,
      'db.ts': `import { getFirestore } from 'firebase/firestore'; export const db = getFirestore();`,
    });
    expect(out).toHaveLength(1);
    expect(out[0].resolution).toBe('unresolved');
    expect(out[0].op).toBe('query');
    expect(out[0].path).toBe('todos');
    expect(out[0].reason).toContain('passed to useCollection()');
  });
});

describe('extractAccessSites: Realtime Database', () => {
  test('set, update multi-path, remove, push, onDisconnect', () => {
    const out = sites({
      'rt.ts': `
        import { getDatabase, ref, child, set, update, remove, push, onDisconnect, serverTimestamp } from 'firebase/database';
        import { getAuth } from 'firebase/auth';
        const db = getDatabase();
        export function online() {
          const user = getAuth().currentUser!;
          const me = ref(db, \`status/\${user.uid}\`);
          onDisconnect(me).remove();
          set(me, { state: 'online', at: serverTimestamp() });
        }
        export function fanout(roomId: string, text: string) {
          const id = push(ref(db, 'messages')).key;
          update(ref(db), { [\`messages/\${roomId}/\${id}\`]: { text }, ['rooms/' + roomId + '/last']: text });
        }
        export const leave = (roomId: string, uid: string) => remove(child(ref(db, 'rooms'), \`\${roomId}/members/\${uid}\`));
        export const say = (roomId: string, text: string) => push(ref(db, \`chat/\${roomId}\`), { text });
      `,
    });
    expect(brief(out)).toEqual([
      'rt.ts:8 onDisconnect.remove status/$uid resolved',
      'rt.ts:9 set status/$uid resolved',
      'rt.ts:13 update messages/$roomId/$id resolved',
      'rt.ts:13 update rooms/$roomId/last resolved',
      'rt.ts:15 remove rooms/$roomId/members/$uid resolved',
      'rt.ts:16 push chat/$roomId/$pushId resolved',
    ]);
    expect(out[0].pathVariables).toEqual([{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }]);
    expect(out[2].multiPath).toBe(true);
  });

  test('a ref stored on an object and passed through a class', () => {
    const out = sites({
      'session.ts': `
        import { child, onDisconnect, set, update, DatabaseReference } from 'firebase/database';
        type Info = { writeRef: DatabaseReference };
        class Session {
          private infos: Record<string, Info> = {};
          constructor(private options: { myId: string; signalRef: DatabaseReference }) {}
          add(pid: string) {
            let writeRef: DatabaseReference;
            writeRef = child(this.options.signalRef, \`\${this.options.myId}/\${pid}\`);
            const info: Info = { writeRef };
            this.infos[pid] = info;
            const d = onDisconnect(writeRef);
            d.set(null);
          }
          offer(pid: string) {
            let info = this.infos[pid];
            let { writeRef } = info;
            update(writeRef, { offer: 'x' });
            set(child(writeRef, 'ice/' + pid), { c: 1 });
          }
        }
        export function session(options: { myId: string; signalRef: DatabaseReference }) {
          return new Session(options);
        }
      `,
      'provider.ts': `
        import { getDatabase, ref, child } from 'firebase/database';
        import { getAuth } from 'firebase/auth';
        import { session } from './session';
        export function start(roomId: string) {
          const meeting = ref(getDatabase(), \`rooms/\${roomId}/call\`);
          const uid = getAuth().currentUser?.uid;
          return session({ myId: \`\${uid}:tab\`, signalRef: child(meeting, 'signals') });
        }
      `,
    });
    expect(brief(out)).toEqual([
      'session.ts:13 onDisconnect.set rooms/$roomId/call/signals/$myId/$pid resolved',
      'session.ts:18 update rooms/$roomId/call/signals/$myId/$pid resolved',
      'session.ts:19 set rooms/$roomId/call/signals/$myId/$pid/ice/$pid2 resolved',
    ]);
    expect(out[1].pathVariables?.[1]).toEqual({ name: 'myId', auth: [{ source: 'auth.uid', certainty: 'partial' }], pattern: '{auth.uid}:tab' });
  });

  test('a ref parameter with no in-project caller is unresolved with the reason', () => {
    const out = sites({
      'lib.ts': `
        import { set, DatabaseReference } from 'firebase/database';
        export function save(target: DatabaseReference, value: number) {
          return set(target, value);
        }
      `,
    });
    expect(out).toHaveLength(1);
    expect(out[0].resolution).toBe('unresolved');
    expect(out[0].reason).toContain("no in-project caller of 'save' supplies parameter 'target'");
  });
});

describe('extractAccessSites: resolution through the project', () => {
  test('a path registry of arrow functions and a tsconfig path alias', () => {
    const out = sites({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@core/*': ['./core/*'] } }, include: ['web', 'core'] }),
      'core/config.ts': `export const ROOT = 'app'; export const ROOMS = \`\${ROOT}/rooms\`;`,
      'core/paths.ts': `
        import { ROOMS } from './config';
        export const dbPaths = {
          member: (roomId: string, uid: string) => \`\${ROOMS}/\${roomId}/members/\${uid}\`,
        };
      `,
      'web/join.ts': `
        import { getDatabase, ref, set } from 'firebase/database';
        import { getAuth, onAuthStateChanged } from 'firebase/auth';
        import { dbPaths } from '@core/paths';
        export function watch(roomId: string) {
          onAuthStateChanged(getAuth(), (user) => {
            if (user) set(ref(getDatabase(), dbPaths.member(roomId, user.uid)), { joined: true, uid: user.uid });
          });
        }
      `,
    });
    expect(brief(out)).toEqual(['web/join.ts:7 set app/rooms/$roomId/members/$uid resolved']);
    expect(out[0].pathVariables?.[1]).toEqual({ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] });
    expect(out[0].payload?.fields[1]).toEqual({ name: 'uid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] });
  });

  test('the signed-in user through a React context provider and useState', () => {
    const out = sites({
      'auth.tsx': `
        import { createContext, useContext, useEffect, useState } from 'react';
        import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
        const Ctx = createContext<{ user: User | null }>({ user: null });
        export function AuthProvider({ children }: { children: any }) {
          const [user, setUser] = useState<User | null>(null);
          useEffect(() => onAuthStateChanged(getAuth(), (u) => setUser(u)), []);
          return <Ctx.Provider value={{ user }}>{children}</Ctx.Provider>;
        }
        export const useAuth = () => useContext(Ctx);
      `,
      'profile.tsx': `
        import { doc, getFirestore, setDoc } from 'firebase/firestore';
        import { useAuth } from './auth';
        export function Profile() {
          const { user } = useAuth();
          const save = (name: string) => setDoc(doc(getFirestore(), 'profiles', user!.uid), { name, owner: user?.uid ?? '' });
          return null;
        }
      `,
    });
    expect(brief(out)).toEqual(['profile.tsx:6 setDoc profiles/{uid} resolved']);
    expect(out[0].pathVariables).toEqual([{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }]);
    expect(out[0].payload?.fields[1]).toEqual({ name: 'owner', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'partial' }] });
  });

  test('namespace imports and in-project re-exports of the SDK', () => {
    const out = sites({
      'fb.ts': `export * from 'firebase/firestore'; export { ref as dbRef, set as dbSet, getDatabase } from 'firebase/database';`,
      'use.ts': `
        import * as fs from 'firebase/firestore';
        import { doc, getFirestore, dbRef, dbSet, getDatabase } from './fb';
        fs.setDoc(doc(getFirestore(), 'a/b'), { x: 1 });
        dbSet(dbRef(getDatabase(), 'c/d'), 1);
      `,
    });
    expect(brief(out)).toEqual(['use.ts:4 setDoc a/b resolved', 'use.ts:5 set c/d resolved']);
  });

  test('test files are not scanned', () => {
    const out = sites({
      'app.test.ts': `import { getDatabase, ref, set } from 'firebase/database'; set(ref(getDatabase(), 'x'), 1);`,
    });
    expect(out).toEqual([]);
  });
});

describe('extractAccessSites: operations inside in-project wrappers', () => {
  test('a driver factory whose wrapper methods call the SDK is specialized at each caller', () => {
    const out = sites({
      'driver.ts': `
        import { getDatabase, ref, set, update, remove } from 'firebase/database';
        function normalizePath(p: string) { return p.replace(/^\\/+|\\/+$/g, ''); }
        export function docRef(db: any, path: string) {
          const norm = normalizePath(path);
          const native = ref(db, norm);
          return {
            path: norm,
            set(value: unknown) { return set(native, value); },
            update(patch: object) { return update(native, patch); },
            delete() { return remove(native); },
          };
        }
        export function createDriver(db: any) {
          return { doc: (path: string) => docRef(db, path) };
        }
        export const driver = createDriver(getDatabase());
      `,
      'paths.ts': `export const paths = { member: (roomId: string, uid: string) => \`/rooms/\${roomId}/members/\${uid}/\` };`,
      'refs.ts': `
        import { driver } from './driver';
        import { paths } from './paths';
        export const refs = { member: (p: { roomId: string; uid: string }) => driver.doc(paths.member(p.roomId, p.uid)) };
      `,
      'app.ts': `
        import { getAuth } from 'firebase/auth';
        import { refs } from './refs';
        export async function join(roomId: string) {
          const uid = getAuth().currentUser!.uid;
          await refs.member({ roomId, uid }).set({ joined: true, uid });
          await refs.member({ roomId, uid }).delete();
        }
      `,
    });
    expect(out.map((s) => `${s.source} ${s.op} ${s.path} ${s.resolution} via ${s.through}`)).toEqual([
      'app.ts:6 set rooms/$roomId/members/$uid resolved via driver.ts:9',
      'app.ts:7 remove rooms/$roomId/members/$uid resolved via driver.ts:11',
      // Never called: stays where it is written, partial, with the reason.
      'driver.ts:10 update $norm partial via undefined',
    ]);
    expect(out[0].pathVariables?.[1]).toEqual({ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] });
  });

  test('a helper whose path is a whole-path parameter is reported at each caller, and stays put when uncalled', () => {
    const out = sites({
      'db.ts': `
        import { doc, getFirestore, setDoc } from 'firebase/firestore';
        export function save(path: string, data: object) { return setDoc(doc(getFirestore(), path), data); }
        export function unusedSave(path: string) { return setDoc(doc(getFirestore(), path), {}); }
      `,
      'use.ts': `
        import { save } from './db';
        export const post = (id: string) => save(\`posts/\${id}\`, { title: 'x' });
        export const tag = (id: string) => save('tags/' + id, { n: 1 });
      `,
    });
    expect(out.map((s) => `${s.source} ${s.path} ${s.resolution}`)).toEqual([
      'db.ts:4 {path} partial',
      'use.ts:3 posts/{id} resolved',
      'use.ts:4 tags/{id} resolved',
    ]);
    expect(out[0].reason).toContain("the whole path is the variable 'path'");
  });
});

