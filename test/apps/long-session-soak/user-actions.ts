// The actions a user takes in the app: auth through the soak helpers and the
// template's own buttons, Firestore reads and writes, and listeners. Each one
// checks its result against the model as it goes.
import assert from 'node:assert/strict';
import { escapeRegExp, until } from './model.ts';
import type { Account } from './page-api.ts';
import { MAX_GOOGLE_ACCOUNTS, SETTLE_MS, TAGS, type SoakPage } from './page-api.ts';
import type { Session } from './session.ts';

declare const soak: SoakPage;

export async function signUp(s: Session, index: number): Promise<void> {
  const email = `soak${s.model.accounts.length}@example.com`;
  const password = `password-${index}`;
  await s.dropListeners();
  const uid = await s.call('soak.signUp()', (page) => page.evaluate(([e, p]) => soak.signUp(e, p), [email, password] as const));
  const account = { email, password, uid };
  s.model.accounts.push(account);
  s.model.current = account;
  s.note(`${email} uid ${uid}`);
  await s.untilStatus(new RegExp(`^Signed in as ${escapeRegExp(email)}$`));
}

export async function signIn(s: Session): Promise<void> {
  const account = s.random.pick(s.model.accounts.filter((candidate) => candidate.password !== null));
  s.note(account.email);
  await s.dropListeners();
  const uid = await s.call('soak.signIn()', (page) => page.evaluate(([e, p]) => soak.signIn(e, p), [account.email, account.password!] as const));
  assert.equal(uid, account.uid, `signing in as ${account.email} gave another uid`);
  s.model.current = account;
  await s.untilStatus(/^Signed in as /);
}

/** The accounts signed in with Google, which the sandbox's dialog lists. */
function googleAccounts(s: Session): Account[] {
  return s.model.accounts.filter((account) => account.password === null);
}

/** The template's own button, through the sandbox's Google dialog: a new account (up to MAX_GOOGLE_ACCOUNTS), or one signed in before. */
export async function signInWithGoogle(s: Session): Promise<void> {
  const known = googleAccounts(s);
  const roomForNew = known.length < MAX_GOOGLE_ACCOUNTS;
  const reuse = known.length > 0 && (!roomForNew || s.random.next() < 0.6);
  const account = reuse ? s.random.pick(known) : undefined;
  const email = account?.email ?? `google${known.length}@example.com`;
  s.note(`${email}${reuse ? ' again' : ''}`);
  await s.page.locator('#sign-in').click({ timeout: SETTLE_MS });
  const dialog = s.page.locator('dialog[data-pyric-auth][open]');
  await dialog.waitFor({ state: 'visible', timeout: SETTLE_MS });
  if (account) {
    // The dialog lists the accounts signed in before, as Google's account chooser does.
    await dialog.locator('.ids button', { hasText: email }).click({ timeout: SETTLE_MS });
  } else {
    await dialog.locator('input[type="email"]').fill(email);
    await dialog.locator('button.submit').click({ timeout: SETTLE_MS });
  }
  await s.untilStatus(/^Signed in as /);
  const uid = await s.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid()));
  assert.ok(uid, 'the Google sign-in left no current user');
  if (account) assert.equal(uid, account.uid, `signing in with Google as ${email} again gave another uid`);
  const signedIn = account ?? { email, password: null, uid };
  if (!account) s.model.accounts.push(signedIn);
  s.model.current = signedIn;
}

export async function signOut(s: Session): Promise<void> {
  await s.dropListeners();
  await s.page.locator('#sign-out').click({ timeout: SETTLE_MS });
  await s.untilStatus(/^Signed out$/);
  assert.equal(await s.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid())), null);
  s.model.current = null;
}

/** The template's own form. Signed out, the template's rules deny the write and the page says so. */
export async function addPostInForm(s: Session, index: number): Promise<void> {
  const title = `form post ${index}`;
  await s.page.locator('#post-title').fill(title, { timeout: SETTLE_MS });
  await s.page.locator('#add-post button[type="submit"]').click({ timeout: SETTLE_MS });
  if (s.model.current === null) {
    await s.untilStatus(/^Denied by rules \(signed out\)/);
    // The template leaves a denied title in the field.
    await s.page.locator('#post-title').fill('', { timeout: SETTLE_MS });
    return;
  }
  await until(`the template's list did not show "${title}"`, SETTLE_MS, async () => (await s.listedTitles()).includes(title));
  const ids = await s.call('soak.idsWithTitle()', (page) => page.evaluate((t) => soak.idsWithTitle(t), title));
  assert.equal(ids.length, 1, `the form added ${ids.length} posts titled "${title}"`);
  s.model.currentPosts().set(ids[0]!, { title, n: null, tag: null });
  s.note(ids[0]!);
}

export async function setPost(s: Session, index: number): Promise<void> {
  const id = `p${index}`;
  const post = { title: `post ${index}`, n: s.random.int(0, 1000), tag: s.random.pick(TAGS) };
  s.note(`${id} tag ${post.tag}`);
  await s.call('soak.setPost()', (page) => page.evaluate(([i, p]) => soak.setPost(i, p), [id, post] as const));
  s.model.currentPosts().set(id, post);
}

export async function updatePost(s: Session): Promise<void> {
  const id = s.random.pick(s.model.currentIds());
  const patch = { n: s.random.int(0, 1000), tag: s.random.pick(TAGS) };
  s.note(`${id} tag ${patch.tag}`);
  await s.call('soak.updatePost()', (page) => page.evaluate(([i, p]) => soak.updatePost(i, p), [id, patch] as const));
  const posts = s.model.currentPosts();
  posts.set(id, { ...posts.get(id)!, ...patch });
}

export async function deletePost(s: Session): Promise<void> {
  const id = s.random.pick(s.model.currentIds());
  s.note(id);
  await s.call('soak.deletePost()', (page) => page.evaluate((i) => soak.deletePost(i), id));
  s.model.currentPosts().delete(id);
}

export async function readPost(s: Session): Promise<void> {
  const id = s.random.pick(s.model.currentIds());
  s.note(id);
  const read = await s.call('soak.getPost()', (page) => page.evaluate((i) => soak.getPost(i), id));
  assert.deepEqual(read, s.model.currentPosts().get(id), `post ${id} read back differently`);
}

export async function queryByTag(s: Session): Promise<void> {
  const tag = s.random.pick(TAGS);
  s.note(`tag ${tag}`);
  const ids = await s.call('soak.idsWithTag()', (page) => page.evaluate((t) => soak.idsWithTag(t), tag));
  assert.deepEqual(ids, s.model.idsWithTag(tag), `the query for tag ${tag} returned other posts`);
}

export async function writeAsAnotherUser(s: Session, index: number): Promise<void> {
  const other = s.random.pick(s.model.others());
  s.note(other.email);
  const code = await s.call('soak.writeAs()', (page) => page.evaluate(([u, i]) => soak.writeAs(u, i), [other.uid, `x${index}`] as const));
  assert.equal(code, 'permission-denied', `a write into ${other.email}'s posts was not denied`);
}

export async function addListener(s: Session, index: number): Promise<void> {
  const key = `l${index}`;
  const tag = s.random.pick(TAGS);
  s.note(`${key} tag ${tag}`);
  await s.call('soak.listen()', (page) => page.evaluate(([k, t]) => soak.listen(k, t), [key, tag] as const));
  s.model.listeners.set(key, tag);
  await s.listenersMatch();
}

export async function removeListener(s: Session): Promise<void> {
  const key = s.random.pick([...s.model.listeners.keys()].sort());
  s.note(key);
  await s.call('soak.unlisten()', (page) => page.evaluate((k) => soak.unlisten(k), key));
  s.model.listeners.delete(key);
}
