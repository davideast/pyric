/**
 * Object generations: the version number every write of an object gets.
 *
 * Production gives each version of an object its own generation, a numeric
 * string at microsecond magnitude that increases with each write
 * (`storage-upload-then-getmetadata.json` observed `'1779067804587568'`).
 * Generation-guarded reads and rollbacks tell two versions apart by it, so two
 * writes must never share one, even in the same millisecond or under a fixed
 * sandbox clock (issue #1160).
 *
 * A generation is the sandbox clock's milliseconds times 1000 (the clock has
 * no finer reading, so this only matches production's magnitude), raised
 * above both the generation stored at the path and every generation this
 * sandbox has issued for the path. The stored generation keeps an overwrite
 * increasing after the store is reopened in a new process; the issued mark
 * keeps it increasing after a delete or a restore to an earlier version, in
 * one process. Two sandboxes sharing one store can still repeat a generation,
 * and so can a reopen followed by a restore. Different objects written
 * in one clock tick share the clock's generation, as production allows. Every
 * write plane (in-page, SharedWorker host, Node host, the admin plane) writes
 * through `uploadObject`, which mints here.
 */
import type { Sandbox } from 'pyric/sandbox';

/**
 * The highest generation each sandbox has issued, per bucket and path. Keyed
 * by `Symbol.for` so `src` and `dist` copies of this module share one record
 * per sandbox, as the storage service caches do.
 */
type IssuedGenerations = Map<string, bigint>;
const ISSUED_KEY = Symbol.for('pyric.storage.issued-generations');
const globalIssued = globalThis as { [ISSUED_KEY]?: WeakMap<Sandbox, IssuedGenerations> };
const ISSUED: WeakMap<Sandbox, IssuedGenerations> = (globalIssued[ISSUED_KEY] ??= new WeakMap());

function issuedIn(sandbox: Sandbox): IssuedGenerations {
  const known = ISSUED.get(sandbox);
  if (known !== undefined) return known;
  const issued: IssuedGenerations = new Map();
  ISSUED.set(sandbox, issued);
  return issued;
}

/** A generation read as a number, or `0n` when it is not one. */
function generationValue(generation: string | undefined): bigint {
  const numeric = generation !== undefined && /^[0-9]+$/.test(generation);
  if (numeric) return BigInt(generation);
  return 0n;
}

function larger(a: bigint, b: bigint): bigint {
  if (a > b) return a;
  return b;
}

/** The sandbox clock's milliseconds times 1000, at the magnitude production generations count in. */
export function clockGeneration(epochMs: number): bigint {
  return BigInt(Math.floor(epochMs * 1000));
}

/** Where a write lands: its bucket and its path in that bucket. */
export interface ObjectLocation {
  bucket: string;
  fullPath: string;
}

/**
 * Issue the generation for a new write of an object, given the sandbox clock
 * and the generation stored at the path before the write, if any.
 */
export function issueGeneration(
  sandbox: Sandbox,
  location: ObjectLocation,
  epochMs: number,
  storedGeneration: string | undefined,
): string {
  const issued = issuedIn(sandbox);
  const key = `${location.bucket}/${location.fullPath}`;
  const issuedBefore = issued.get(key) ?? 0n;
  const stored = generationValue(storedGeneration);
  const floor = larger(issuedBefore, stored);
  const next = larger(clockGeneration(epochMs), floor + 1n);
  issued.set(key, next);
  return String(next);
}
