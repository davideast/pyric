/**
 * `databaseAuthVariableOverride` (#3000): firebase-admin's option that runs an
 * app's Realtime Database access through the rules as a given `auth`, or as an
 * unauthenticated client with `null`. Left out, the app keeps admin access.
 *
 * Runs on both arms: the in-process sandbox and a remote handle on the real
 * SharedWorker host behind the bridge, where every operation and subscription
 * carries the override as its `actAs` lens.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type RemoteSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase, ServerValue } from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const RULES = {
  rules: {
    notes: {
      $uid: {
        '.read': 'auth != null && auth.uid == $uid',
        '.write': 'auth != null && auth.uid == $uid && auth.token.gateway == true',
        '.validate': "newData.hasChildren(['text']) || !newData.exists()",
      },
    },
    stamps: {
      $uid: {
        '.write': 'auth != null && auth.uid == $uid',
        '.validate': 'newData.val() == now',
      },
    },
    public: {
      '.read': 'auth == null',
      '.write': 'auth == null',
    },
  },
};

let seq = 0;

const ARMS: ReadonlyArray<{ name: string; makeSandbox: () => Sandbox | RemoteSandbox }> = [
  { name: 'in-process', makeSandbox: () => initializeSandbox({ projectId: `demo-auth-override-${++seq}` }) },
  { name: 'remote (SharedWorker bridge)', makeSandbox: () => sharedWorkerArm().app.sandbox },
];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** A rejection's message, or null when the promise resolved. */
async function refusal(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe.each(ARMS)('databaseAuthVariableOverride [$name]', ({ makeSandbox }) => {
  async function setup(override: unknown): Promise<{ admin: PyricAdminApp; scoped: PyricAdminApp }> {
    const sandbox = makeSandbox();
    const admin = initializeApp({ sandbox }, `override-admin-${++seq}`);
    await getDatabase(admin).setRules(RULES);
    await getDatabase(admin).ref('notes/mallory').set({ text: 'mallory' });
    const scoped = initializeApp(
      { sandbox, databaseAuthVariableOverride: override } as Parameters<typeof initializeApp>[0],
      `override-scoped-${++seq}`,
    );
    return { admin, scoped };
  }

  it('keeps the override in the app options, as firebase-admin does', async () => {
    const override = { uid: 'david', token: { gateway: true } };
    const { scoped } = await setup(override);
    expect(scoped.options.databaseAuthVariableOverride).toEqual(override);
  });

  it('lets rules see the override uid and its token fields', async () => {
    const { admin, scoped } = await setup({ uid: 'david', token: { gateway: true } });
    const db = getDatabase(scoped);
    await db.ref('notes/david').set({ text: 'hello' });
    await db.ref().update({ 'notes/david/text': 'updated', 'stamps/david': ServerValue.TIMESTAMP });
    expect((await db.ref('notes/david').get()).val()).toEqual({ text: 'updated' });
    expect((await getDatabase(admin).ref('notes/david/text').get()).val()).toBe('updated');
    expect(typeof (await getDatabase(admin).ref('stamps/david').get()).val()).toBe('number');
  });

  it('refuses reads and writes the rules refuse for that auth', async () => {
    const { admin, scoped } = await setup({ uid: 'david', token: { gateway: true } });
    const db = getDatabase(scoped);
    expect(await refusal(db.ref('notes/mallory').set({ text: 'overwritten' }))).toMatch(/permission/i);
    expect(await refusal(db.ref('notes/mallory').get())).toMatch(/permission/i);
    expect(await refusal(db.ref('public/x').set(1))).toMatch(/permission/i);
    expect(await refusal(db.ref('notes/david').set({ wrong: 'shape' }))).toMatch(/permission/i);
    expect(await refusal(db.ref('stamps/david').set(1))).toMatch(/permission/i);
    expect((await getDatabase(admin).ref('notes/mallory').get()).val()).toEqual({ text: 'mallory' });
  });

  it('runs value listeners and transactions through the rules', async () => {
    const { scoped } = await setup({ uid: 'david', token: { gateway: true } });
    const db = getDatabase(scoped);
    await db.ref('notes/david').set({ text: 'a' });
    const seen = await db.ref('notes/david').once('value');
    expect(seen.val()).toEqual({ text: 'a' });
    const committed = await db.ref('notes/david').transaction(() => ({ text: 'b' }));
    expect(committed.committed).toBe(true);
    expect(committed.snapshot.val()).toEqual({ text: 'b' });
    expect(await refusal(db.ref('notes/mallory').transaction(() => ({ text: 'taken' })))).toMatch(/permission/i);
  });

  it("can't be forged: another uid, or a missing claim, is refused", async () => {
    const other = await setup({ uid: 'mallory', token: { gateway: true } });
    expect(await refusal(getDatabase(other.scoped).ref('notes/david').set({ text: 'forged' }))).toMatch(/permission/i);
    const noClaim = await setup({ uid: 'david' });
    expect(await refusal(getDatabase(noClaim.scoped).ref('notes/david').set({ text: 'forged' }))).toMatch(/permission/i);
    const wrongType = await setup({ uid: 'david', token: { gateway: 'true' } });
    expect(await refusal(getDatabase(wrongType.scoped).ref('notes/david').set({ text: 'forged' }))).toMatch(/permission/i);
  });

  it('acts as an unauthenticated client with null', async () => {
    const { scoped } = await setup(null);
    const db = getDatabase(scoped);
    await db.ref('public/x').set(1);
    expect((await db.ref('public/x').get()).val()).toBe(1);
    expect(await refusal(db.ref('notes/david').set({ text: 'anon' }))).toMatch(/permission/i);
  });

  it('keeps admin access when the option is left out', async () => {
    const { admin } = await setup(undefined);
    await getDatabase(admin).ref('anywhere/at/all').set(true);
    expect((await getDatabase(admin).ref('anywhere/at/all').get()).val()).toBe(true);
  });

  it('keeps getRules and setRules as admin operations', async () => {
    const { scoped } = await setup({ uid: 'david', token: { gateway: true } });
    const rules = (await getDatabase(scoped).getRulesJSON()) as typeof RULES;
    expect(Object.keys(rules.rules)).toEqual(['notes', 'stamps', 'public']);
  });

  it('refuses an override the sandbox rules cannot represent, instead of dropping it', async () => {
    const { scoped: topLevel } = await setup({ uid: 'david', gateway: true });
    expect(() => getDatabase(topLevel)).toThrow(/`gateway`.*put custom fields under `token`/);
    const { scoped: noUid } = await setup({ token: { gateway: true } });
    expect(() => getDatabase(noUid)).toThrow(/non-empty string `uid`/);
    const { scoped: notObject } = await setup('david');
    expect(() => getDatabase(notObject)).toThrow('Only objects are supported for option databaseAuthVariableOverride');
  });
});
