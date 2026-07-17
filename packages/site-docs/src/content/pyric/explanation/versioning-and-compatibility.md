---
title: "Versioning and the fb tag"
group: "pyric"
section: "Explanation"
order: 10
---
# Versioning and the fb tag

Pyric has its own semver. Firebase compatibility is a separate claim, made by an npm dist-tag:

```
npm install pyric@fb12.13
```

`fb<major>.<minor>` points at the newest pyric release whose conformance gates passed against that line of Firebase. It means **"conformance-tested against Firebase 12.13"** — not "equal to" and not "full parity." The tag is a statement about what was tested, not about how much matched.

Three rules govern it:

- **It is machine-issued.** The tag moves only when the release script runs `compat:check` against the pinned Firebase version and it comes back green. Nobody moves it by hand because they believe pyric is ready.
- **It tracks major.minor lines, never patches.** There is no `fb12.13.1`. Old `fb` tags are never deleted or moved backward, so an install pinned to an older line stays reproducible.
- **It links to numbers, not a slogan.** The claim behind the tag is inspectable on the [conformance scoreboard](https://pyric.dev/docs/pyric-conformance-scores/): public runtime surface, public type surface, and fidelity of tracked behavior, per service. "Tested against" is a link, never a vibe.

The same tested-against version appears everywhere a user forms an impression: the README badge, the npm description, `pyric --version`, and the docs header.

Today: Firebase's latest is 12.16.0, pyric's pinned conformance version is 12.13.0, so the tag is `fb12.13`. A `fb` tag can point at an alpha release — compatibility and stability are separate claims, and `alpha`, `latest`, and `fb12.13` can all resolve to the same publish, each making its own.

Bumping the pinned Firebase version re-snapshots the upstream surface; the diff is the worklist, and the new line's tag appears only when `compat:check` passes against the new pin.
