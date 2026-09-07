/**
 * `pyric/auth/internal` — host-only seam for the sandbox auth backend, on the
 * `pyric/sandbox/internal` / `pyric/storage/internal` precedent.
 *
 * The default-avatar generator is the sandbox's built-in image of last resort.
 * The dev server's `/__pyric/assets/avatar/<uid>` route mounts it as the asset
 * resolver's fallback, so a served page and an in-page sandbox with no server
 * render the SAME deterministic face for a uid. `@pyric/cli` reads it through
 * this subpath rather than reaching into the package's source tree.
 *
 * **Not part of the public API.** These exports mirror no Firebase surface and
 * are never reached by application code, so the conformance census does not
 * measure them. Shape subject to change without breaking-change semantics
 * across versions.
 */
export {
  avatarSeed,
  defaultAvatarDataUri,
  defaultAvatarMint,
  defaultAvatarSvg,
} from './sandbox/default-avatar.js';
export type { AvatarMint, AvatarMintInput } from './sandbox/default-avatar.js';
