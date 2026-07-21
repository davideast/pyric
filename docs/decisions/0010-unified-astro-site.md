# 0010: One Astro host for documentation and Studio

Status: Accepted

Date: 2026-07-21

## Context

The public documentation site and Pyric Studio were separate applications with
separate output trees and fallback rules. The CLI then had to embed, locate,
and serve both trees. That split duplicated navigation and build ownership and
made it possible for a broad Studio fallback to turn a missing documentation
page into an application response.

Studio also has two different kinds of URL. Service pages such as `/firestore`
are a finite part of the product navigation. Sandbox locations such as
`/firestore/users/alice` are data selected at runtime and cannot be enumerated
during a static build.

Documentation examples need a separate boundary. They should run real Pyric
behavior without joining the site's long-lived SharedWorker or sharing state
with another example.

## Decisions

1. **Astro owns the site.** `packages/site-docs` is the single application that
   emits documentation pages, finite Studio entry pages, shared navigation,
   and static assets. `packages/studio` is a React module consumed by Astro; it
   no longer has its own Vite HTML entry or output tree.

2. **Documentation is static and Studio is a client application.** Astro
   renders documentation as HTML. Each finite Studio service page mounts the
   Studio application as a client-only React island. Studio owns deeper
   sandbox-derived URL state and resolves it in the browser.

3. **Public and CLI delivery are build adapters over the same tree.** The
   public build copies the Astro output to `dist/site` and adds the reserved
   `/__pyric/*` runtime assets. The package build embeds the same Astro output
   once under the CLI. The CLI serves a manifest-driven finite Studio fallback
   and returns a real 404 for missing documentation and asset paths.

4. **The SharedWorker belongs only to Studio runtime pages.** Public
   documentation pages do not start it. Studio pages receive the current
   worker generation, and Studio connects to the same generation as the
   application being inspected. Updating the generation remains explicit and
   observable through the runtime UI.

5. **Executable documentation examples use an embedded sandbox.** Each example
   runs in its own iframe and creates a fresh in-memory sandbox through the same
   internal sandbox-root factory used by the SharedWorker. Examples declare
   their services, rules, and seed data. Reset creates a new sandbox. Displayed
   source is imported from the file that is actually executed.

## Consequences

- Site navigation and HTML ownership have one source of truth.
- Studio deep links continue to work without generating one static page per
  possible sandbox path.
- The production documentation site has no background Pyric backend unless a
  reader runs an isolated example.
- CLI packaging has one site directory and one manifest contract to verify.
- A missing docs page cannot be hidden by a Studio SPA fallback.
- New examples must enter the finite example registry and prove execution,
  reset isolation, and source identity.
