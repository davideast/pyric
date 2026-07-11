---
title: "The versioning and compatibility policy"
group: "pyric"
section: "Explanation"
order: 74
---
# The versioning and compatibility policy

Pyric mirrors Firebase's observable behavior. Users need one honest way to ask "which Firebase does this pyric behave like," and pyric needs one honest way to answer. This document is that answer. It defines what the claim means, where it appears, and what has to be true before it can move.

## Pyric keeps its own version and never borrows Firebase's

Pyric versions itself with its own semver, independent of Firebase. It does not adopt Firebase's version number.

Pyric ships a large surface that Firebase does not have: the sandbox runtime, the rules tooling, the CLI. Breaking changes in that surface need their own major and minor releases. A pyric that renamed itself `12.16.0` to match Firebase would be making a promise of parity that the conformance numbers do not support. Pyric's version tracks pyric. Firebase compatibility is stated separately, below.

## Firebase compatibility ships as a dist-tag

The compatibility claim is an npm dist-tag of the form `fb<major>.<minor>`.
```
npm install pyric@fb12.16
```
A `fb<major>.<minor>` tag points at the newest pyric release whose conformance gates pass against that line of Firebase. Installing `pyric@fb12.16` gets you the pyric that has been conformance-tested against Firebase 12.16.

The tag means "conformance-tested against Firebase 12.16." It does not mean "equal to Firebase 12.16" and it does not mean "full parity with Firebase 12.16." Those are claims pyric does not make and the conformance numbers do not back. The tag is a statement about what was tested, not a statement about how much matched.

## Patch releases are not tagged

Pyric tags Firebase's major and minor lines and never its patch level, so there is no `fb12.16.1`; a Firebase patch triggers a pyric release only when the upstream surface snapshot diff for that patch is non-empty, which it usually is not.

## The tag is a certificate, not an opinion

A `fb` tag moves only through the release script, and only when the conformance gate suite `compat:check` is green against the pinned Firebase version.

Nobody moves a tag by hand because they believe pyric is ready. The tag moves because the gates passed. It is a machine-issued certificate. A green `compat:check` is the only thing that issues it, and a red one withholds it. This removes optimism from the claim: the tag says what the tests found, and the tests ran before it moved.

## The certificate appears wherever a user forms an impression

The tested-against version is not only an npm tag. It is stated everywhere a user decides whether to trust pyric:

- The README carries a badge naming the Firebase version pyric is tested against.
- The npm package description names it.
- `pyric --version` prints both numbers: the pyric version and the Firebase version it was tested against.
- The docs header names it.

A user who never runs `npm dist-tag ls` still sees the claim, and sees the same claim in every place.

## The claim links to numbers anyone can read

"Tested against Firebase 12.16" is only honest if the result of that testing is inspectable. Pyric publishes its coverage openly: roughly 51% overall surface coverage, roughly 85% behavior conformance on the slice that is implemented, with per-service numbers in the generated COMPAT documents. The tag refers to those published numbers.

Surface coverage answers "will my app's calls exist against the mirror." Behavior conformance answers "of the calls that exist, do they behave like production." They are different questions and pyric reports them separately. A reader following the tag reaches the numbers, not a slogan. "Tested against" is a link, never a vibe.

## Where the numbers stand today

Firebase's latest npm release is 12.16.0. Pyric's pinned oracle and conformance version is 12.13.0, so the first real tag will be `fb12.13`, the line pyric is actually tested against, not `fb12.16`. Pyric's own packages are at `0.1.0-alpha.8`, in lockstep across `pyric`, `pyric-admin`, `pyric-tools`, and `@pyric/ui`. A `fb` tag can point at an alpha release; the compatibility claim and the stability claim are separate, and the `fb` tag speaks only to the first.

---

## Mechanics, for maintainers

**How the tag is computed and moved.** At publish time, after packages are packed and published, the release step reads the currently pinned Firebase version and runs `compat:check` against it. `compat:check` is the composite gate: registry validation, the surface census gate, a docs freshness check, and the coverage regression check. If it is green, the release script moves `fb<major>.<minor>` for the pinned line to the version being published, using the same `npm dist-tag add` mechanism the script already uses for `latest`. If it is red, the `fb` tag does not move and the release does not carry a compatibility claim. The minor is derived from the pinned version; the patch component of the pin is discarded when forming the tag.

**What happens on a Firebase pin bump.** Raising the pinned Firebase version starts by re-snapshotting the upstream surface. The diff between the old snapshot and the new one is the worklist: new exports, changed signatures, removed surface. Bumping the pin does not create the new `fb` tag. The tag for the new line, for example `fb12.16`, appears only after the worklist is closed enough that `compat:check` passes against the new pin. Until then, no release claims the new line.

**What happens to old tags.** A `fb` tag for a line pyric no longer pins keeps pointing at the last pyric release that was certified against that line. Old `fb` tags are never deleted and never moved backward. `pyric@fb12.13` continues to resolve to a real, once-certified release even after the pin moves to 12.16, so an install pinned to an older Firebase line stays reproducible.

**Interaction with `alpha` and `latest`.** The `alpha` and `latest` tags are about pyric's own release stream and move on every publish, `alpha` to each publish and `latest` to the same version by the explicit dist-tag step. The `fb` tags are orthogonal: they move only when gates pass against their line, and only the line matching the current pin moves on a given release. Several tags can point at the same version. A single publish can leave `alpha`, `latest`, and `fb12.13` all resolving to `0.1.0-alpha.9`, each making its own separate claim: newest, default, and tested-against-Firebase-12.13.
