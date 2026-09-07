---
title: "Assign default avatars to sandbox users"
navLabel: "Default avatars"
group: "Build"
section: ""
order: 15
description: "Give provider sign-ins a deterministic profile photo automatically, or supply your own avatar set or generation source."
---

# Assign default avatars to sandbox users

A real Google or GitHub sign-in always returns a `photoURL`, and application code renders it on that assumption, with no null check. The sandbox gives provider-created users the same guarantee. Password, phone, and anonymous sign-ins still get `photoURL: null`, matching Firebase.

## Get a photo with no configuration

```ts
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';

const credential = await signInWithPopup(auth, new GoogleAuthProvider());
console.log(credential.user.photoURL); // a generated avatar, never null
```

With no `avatars` option, `pyric()` mints a deterministic image for every provider-created user: a two-hue gradient carrying the user's first initial. The image is derived from the uid, so the same user gets the same face in every session and on every machine.

Only federated identity providers qualify: Google, GitHub, and any other provider whose id contains a dot (`google.com`, `github.com`, `oidc.acme`). See [What stays null](#what-stays-null) for the sign-in methods that keep `photoURL` empty, exactly as Firebase does.

## Turn avatars off

Set `avatars: false` to reproduce Firebase's own behaviour for a provider that supplies no photo:

```ts
pyric({ avatars: false })
```

Every provider-created user's `photoURL` is `null`, and the `/__pyric/assets/avatar/*` route is not mounted at all.

## Use a pre-built avatar set

Point `avatars` at a directory to serve fixed images instead of generated ones:

```ts
pyric({ avatars: './avatars/anime' })
```

The directory is a `manifest.json` file plus the images it names:

```json
{
  "version": 1,
  "images": [
    { "file": "001.png" },
    { "file": "002.png" },
    { "file": "003.png" }
  ]
}
```

Assignment is deterministic: a hash of the user's resolution seed picks one index into `images`, so a given user keeps the same picture across restarts and sessions. `manifest.json` accepts PNG, JPEG, SVG, and WebP files, and an image entry can name its own `contentType` when the file extension does not already say so.

## Generate avatars with a custom source

Pass a `source` function to produce images yourself instead of picking from a fixed set:

```ts
pyric({
  avatars: {
    source: async ({ context, seed }) => {
      const displayName = context.displayName as string | null;
      const png = await renderInitialsAvatar(displayName, seed);
      return { data: png, contentType: 'image/png' };
    },
  },
})
```

The source runs in the Vite dev server process, never in the browser, the same server-only boundary [AI Logic's proxy](./ai-logic.md) uses for its own upstream credentials. `context` carries `uid`, `displayName`, `email`, and `providerId` for the user being resolved; `seed` is the deterministic value a pool-based source would hash instead.

A source returns one of two shapes:

- `{ data, contentType }`: raw bytes and a content type (`image/png`, `image/jpeg`, `image/svg+xml`, or `image/webp`), written to the cache exactly as returned.
- `{ url }`: an existing image's URL. Pyric fetches it once and caches the bytes. It never redirects the browser there itself, so the sandbox keeps serving that user's avatar even when the network is unavailable later.

The source runs once per user, ever. The first request for a uid calls it and writes the result under `.pyric/assets/avatars/`; every later request, in this session or a future one, is served straight from that cache without calling the source again. Concurrent first requests for the same uid share a single in-flight call rather than starting it twice. A source that throws, or a fetched `url` that fails, serves the built-in generated avatar for that one request without caching it, so the next request tries again.

A slow source never leaves the application waiting. A request waits up to two seconds for the source, then answers immediately with the built-in generated avatar while generation carries on in the background. The next request for that user, from a re-render, a reload, or a later session, serves the finished image from the cache. Your application needs no loading state: the placeholder is itself a complete avatar, in the same image slot the finished one will occupy.

A filled cache is itself a valid avatar set, in the same `manifest.json` format described [above](#use-a-pre-built-avatar-set). Once `.pyric/assets/avatars/` holds the images you want, stop calling the source and point `avatars` at that directory, or copy it out of the gitignored `.pyric/` directory into your project and commit it as a checked-in set.

## Configure `pyric sandbox` with an environment variable

Running a static application or a Node process without the Vite plugin, `pyric sandbox` reads `PYRIC_AVATARS` instead of a plugin option:

```dotenv
PYRIC_AVATARS=./avatars/anime
```

`0` and `false` disable avatars, the environment equivalent of `avatars: false`. Any other value names a set directory, resolved from the project root. There is no `--avatars` flag: `pyric sandbox` supports the generated default and a pre-built set, not a custom source, because a function has no command-line spelling. See the [CLI reference](../reference/cli.md#environment-variables) for how this sits alongside Pyric's other environment variables.

## Without a dev server

Running with no Vite plugin and no `pyric sandbox` process behind it, the sandbox has no `/__pyric/assets/avatar/*` route to resolve against. `photoURL` is set to a small `data:image/svg+xml,...` URI instead: the same deterministic gradient-and-initial image, generated inline and readable with no network request. A pre-built set or a custom source both need a dev server; without one, every provider user gets the generated default.

## What stays null

Firebase itself only populates `photoURL` for a federated identity provider, and the sandbox matches that regardless of the `avatars` option:

- Password sign-in, through `createUserWithEmailAndPassword`.
- Phone sign-in.
- Anonymous sign-in, through `signInAnonymously`.

Each of these leaves `photoURL` as `null` at creation. It stays `null` unless your own code sets it, for instance with `updateProfile`.

## Where to go next

[Run Firebase Authentication locally](./authentication.md) covers the rest of the auth surface: seeding users, switching identities, and connecting a uid to your Security Rules.
