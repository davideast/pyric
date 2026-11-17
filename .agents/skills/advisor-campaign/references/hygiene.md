# Hygiene: generalized issues, pull requests, and commits

Apply these rules whenever drafting, editing, or commenting on a GitHub issue,
pull request, commit message, test fixture, or campaign verdict comment in this
repository.

## 1. Generic contracts and synthetic domain nouns

Frame every title, narrative heading, rule snippet, query, and test payload around
the underlying contract and mechanism using minimal synthetic domain nouns such as
`users/$uid`, `items/{id}`, `docs/{docId}`, or `buckets/default`.

Never copy or adapt identifiers, collection paths, schemas, product terms, or UI
concepts from an external application, benchmark fixture, audit, or defect hunt
that surfaced the issue.

## 2. Standalone public-API reproductions only

Every code block in an issue body or pull request description must be
self-contained, runnable from a consumer's perspective, and import only published
package entrypoints (`pyric/*`, `pyric-admin/*`, `@pyric/*`), CLI commands, or
workflow commands.

Never import internal `packages/*/src/*` paths inside issue or pull request code
blocks. Cite internal implementation files and line numbers in prose or inside
`<details>` notes instead.

## 3. Zero environment, session, or private ops leakage

Never include any of the following in repository files, commit messages, pull
request descriptions, issue bodies, or review comments:

- machine-local or personal filesystem paths (home directories, workspace mounts,
  editor config directories, or host scratch paths);
- session UUIDs, conversation IDs, worker IDs, or internal shortlinks;
- agent, model, or vendor names;
- hunt finding prefixes or internal tracking IDs;
- private operational details: cloud project IDs, service account emails, billing
  or spend figures, or external repository names. When campaign runbooks, ledgers,
  or operational state live outside this repository, refer to them generically as
  "the private ops repo".

## 4. Plain ASCII everywhere

Keep all authored source files, tests, Markdown documents, commit messages, pull
request titles and bodies, and verdict comments strictly within 7-bit ASCII
(byte values `<= 127`):

- write `--` or a comma instead of em or en dashes;
- write `->` or `<-` instead of Unicode arrows;
- write straight quotes (`"` and `'`) instead of curly quotes;
- avoid emoji or decorative Unicode symbols in authored text.

Verify your slice's changed files and commit message before committing or opening
a pull request:

```sh
LC_ALL=C grep -rn '[^ -~	]' <changed-paths>
git log -1 --format=%B HEAD | LC_ALL=C grep -n '[^ -~	]'
```
