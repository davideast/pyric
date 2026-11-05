// What the script wrote, and so what the app must read back, with the
// comparisons the checks use and the time limits every call runs under.
import assert from 'node:assert/strict';
import { sleep } from '../driver.ts';
import type { Account, Post } from './page-api.ts';

export class Model {
  readonly accounts: Account[] = [];
  current: Account | null = null;
  private readonly posts = new Map<string, Map<string, Post>>();
  readonly listeners = new Map<string, string>();

  postsOf(uid: string): Map<string, Post> {
    let posts = this.posts.get(uid);
    if (!posts) this.posts.set(uid, (posts = new Map()));
    return posts;
  }

  currentPosts(): Map<string, Post> {
    assert.ok(this.current, 'the model has no signed-in account');
    return this.postsOf(this.current.uid);
  }

  /** The current account's post ids, sorted, so a pick by index replays. */
  currentIds(): string[] {
    return [...this.currentPosts().keys()].sort();
  }

  idsWithTag(tag: string): string[] {
    return [...this.currentPosts()].filter(([, post]) => post.tag === tag).map(([id]) => id).sort();
  }

  others(): Account[] {
    return this.accounts.filter((account) => account !== this.current);
  }
}

/** Settles `pending` within `ms`, or fails naming the call that never settled. */
export function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

export async function until(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms / 1000}s`);
    await sleep(100);
  }
}

/** A record as JSON with its keys in order, to compare two without regard to insertion order. */
export function canonical(record: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sortedEntries(record: Record<string, Post> | Map<string, Post>): Array<[string, Post]> {
  const entries = record instanceof Map ? [...record] : Object.entries(record);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
