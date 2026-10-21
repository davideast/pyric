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
 * The backend issues a write's generation inside the write's own transaction.
 * It passes the issuer a floor: the larger of the generation stored at the
 * path and the path's high-water mark, the highest generation ever stored
 * there, which the backend keeps through deletes, resets, reopens and
 * restores. The issuer returns the sandbox clock's milliseconds times 1000
 * (the clock has no finer reading, so this only matches production's
 * magnitude), or one more than the floor when that is not larger. Different
 * objects written in one clock tick share the clock's generation, as
 * production allows. Every write plane (in-page, SharedWorker host, Node host,
 * the admin plane) writes through `uploadObject`, which passes the issuer.
 */

/** Issues a write's generation above `floor`, the highest generation the path has had. */
export type GenerationIssuer = (floor: string | undefined) => string;

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

/** The higher of two generations, or `undefined` when neither is set. */
export function higherGeneration(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (generationValue(a) >= generationValue(b)) return a;
  return b;
}

/** A path's mark after a write stores `generation`: the higher of the two. */
export function raisedMark(mark: string | undefined, generation: string): string {
  return higherGeneration(mark, generation) ?? generation;
}

/** The sandbox clock's milliseconds times 1000, at the magnitude production generations count in. */
export function clockGeneration(epochMs: number): bigint {
  return BigInt(Math.floor(epochMs * 1000));
}

/** The issuer for a write at `epochMs` on the sandbox clock. */
export function generationIssuer(epochMs: number): GenerationIssuer {
  return (floor) => String(larger(clockGeneration(epochMs), generationValue(floor) + 1n));
}
