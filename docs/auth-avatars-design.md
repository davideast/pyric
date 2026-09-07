# Design: default profile photos for sandbox auth users

Status: agreed direction, implementation in progress on `feat/auth-avatars`.

## Problem

Real OAuth providers always return a `photoURL`. A Google sign-in never yields
`user.photoURL === null`, so production application code renders it without a
null check. The sandbox Auth mirror defaults `photoUrl` to `null` on every
creation path, so the same code breaks during local development. This is a
fidelity gap, not a cosmetic one.

Two adjacent defects make the gap worse:

- The provider sign-in bridge (`ResolvedIdentity`, `acceptIdentity`) cannot
  carry a photo at all.
- `exportUsers()` round-trips through `SeedUser`, which silently drops
  `photoUrl`, `phoneNumber`, `emailVerified`, and `disabled` on every
  snapshot, restore, and persisted-state write.

## Design summary

Assign the URL synchronously, resolve the image lazily.

The sandbox assigns a stable `photoURL` at the moment a user record is
created, inside the existing creation choke point
(`SandboxBackend.makeStored`). The image behind that URL resolves when it is
first fetched:

- **Served modes** (Vite plugin, `pyric sandbox`, the Next.js rewrite):
  `photoURL` is `/__pyric/assets/avatar/<uid>?d=<seed>&...`. A namespace route
  resolves it against the configured avatar source, caches the bytes to disk,
  and serves them.
- **In-page mode** (no CLI, no server): `photoURL` is a small deterministic
  SVG data URI generated in shared `pyric` code.

This model was chosen over intercepting a user-creation event because the
event relay from the worker to the dev server does not exist, and because an
asynchronous patch leaves `photoURL` briefly `null` after sign-in, which is
the exact failure being fixed. With lazy resolution the field is populated
the instant the user object exists; slow generation only delays the pixels.

## Who gets a photo

Provider-created users always; everyone else stays `null`. Firebase itself
only populates `photoURL` for OAuth provider users, and
`createUserWithEmailAndPassword` and `signInAnonymously` return `null` in
production. Defaulting every user would introduce a new divergence while
fixing this one.

## One concept: the avatar source

A single interface with three implementations. A pre-created image set is a
static source, so the plugin system and the simple case are the same
abstraction.

```ts
// Zero config: provider users get deterministic generated avatars.
pyric()

// Off switch: Firebase-null behaviour, for testing the null case.
pyric({ avatars: false })

// A pre-created avatar set: local directory or installed package.
pyric({ avatars: './avatars/anime' })

// The substrate: an async source, runs in the dev server process.
pyric({
  avatars: {
    source: async ({ key, seed, context }) => {
      const png = await generate(context.displayName, seed)
      return { data: png, contentType: 'image/png' }
      // or: return { url: existingImageUrl }  (fetched once, cached)
    },
  },
})
```

The callback runs in the dev server process, never the browser, mirroring the
AI proxy asymmetry: server-only configuration does not reach the page, and
secrets stay in the server environment.

## Resolution pipeline

A fetch of `/__pyric/assets/avatar/<uid>` runs:

1. **Cache check.** A keyed entry in the asset directory serves immediately.
   The source never runs twice for the same user.
2. **Miss: run the source.** The configured callback executes server-side,
   asynchronously.
3. **Normalise to bytes.** A `{ data, contentType }` result is used directly.
   A `{ url }` result is fetched once and stored: cache-through, never
   redirect, so the sandbox stays offline-capable.
4. **Write, then serve.** Bytes land in the cache with a manifest entry.

Semantics:

- **Once per key, ever.** The cache is write-once per uid across sessions.
  A uid's face never changes. Regeneration is an explicit act (delete the
  entry or the directory).
- **Failure never caches.** A source error serves the built-in generated
  fallback without writing it, so the next fetch retries.
- **Single-flight per key.** Concurrent first fetches run the source once.
- **A slow source never blocks the render.** A resolve waits for the source
  up to a short deadline (2 seconds), then serves the built-in generated
  avatar as an interim response with `no-store` while generation finishes
  in the background and lands in the cache. The next fetch of that URL
  (a re-render, reload, or later session) upgrades to the generated image.
  The placeholder is an image in the image slot, not loading UI, so
  applications inherit nothing to theme and there is no loading state to
  build.

## The set format

A directory with a `manifest.json` and image files:

```json
{ "version": 1, "images": [{ "file": "001.png" }, { "file": "002.png" }] }
```

An image without a `key` belongs to the pool; assignment is
`hash(seed) % pool length`, so a user keeps the same image across sessions.
An image with a `key` is a materialised assignment. The callback cache writes
keyed entries, which means **a filled cache is a valid avatar set**: stop
using the callback, point `avatars` at the directory, or copy it out of the
gitignored `.pyric/` to commit it. Generation-to-set promotion is a file
copy, not a feature.

## One-way doors

Only decisions that leak into persisted user state are fixed now. Everything
else is renameable under the alpha policy (no deprecation, delete and replace
in one change).

1. **URL shape:** `/__pyric/assets/avatar/<uid>`. Written into persisted
   state, snapshots, and captured sessions.
2. **Cache layout:** `.pyric/assets/avatars/`.
3. **Manifest `version` field:** present from the first release.
4. **Key determinism:** `hash(key)` picks the image, forever.

## Mode availability

| Mode | Generated default | Static sets | Callback source |
|---|---|---|---|
| Vite plugin | yes | yes | yes |
| `pyric sandbox` (static or Node) | yes | `PYRIC_AVATARS` environment variable | not available |
| Next.js `withPyric` | yes | configured on the `pyric sandbox` server | not available |
| In-page, no CLI | yes, as a data URI | programmatic only | programmatic, runs in the page |

The static path is environment-variable only by design: there is no `--avatars`
flag, and a callback needs a module to host it, which only the Vite
configuration provides. The environment variable selects a set directory or
disables the feature.

The avatar route serves plain same-origin `GET` requests because `img`
elements cannot attach capability tokens or custom headers. The route is
classified with the public static routes, not the token-gated channels, and
that classification is deliberate.

## How this generalises, recorded but not built

The substrate splits into a part that generalises and a part that does not.
The service-neutral part is the source interface, the set format, and the
materialisation cache. The delivery wiring is per-service: avatars store a
URL and resolve lazily through a route; a future Storage seeding consumer
needs bytes inside the sandbox and would call the same resolver eagerly at
seed time.

Three invariants make a new consumer safe:

1. A stable key minted deterministically, because the URL is written into
   persisted data.
2. Everything the source needs travels in the URL or the cache manifest.
3. A per-consumer degrade story for modes with no server.

Adding a consumer costs a prefix segment under `/__pyric/assets/`, a mint
point in that service's code, and a configured source. No registration
system, no shared configuration block, no generic option surface. None of
that ships until a second consumer actually exists; the most likely first
candidate is seeded Firestore data whose image URL fields currently point
nowhere.

## Out of scope for the first release

- Any Storage integration, including stubs.
- Multi-consumer manifest schema, categories, or a set registry.
- A generic `assets` option in the plugin configuration.
- Set discovery or plugin registration; a set is a directory or package path.
- Showing avatars in the provider account picker.
- Auto-populating non-provider users (may become an option later).
