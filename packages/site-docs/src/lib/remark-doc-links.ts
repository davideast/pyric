/**
 * Site-local remark plugin: resolve authored relative `.md` links against the
 * content tree and rewrite them to nested route URLs.
 *
 * Rules:
 *   - Only relative links whose path ends in `.md` are touched. Directory URLs
 *     (`../firestore-compat/`), absolute URLs, and `#fragment` links pass
 *     through untouched.
 *   - The target file must exist under src/content (authored or _generated) —
 *     a link to a nonexistent file FAILS THE BUILD (no silent plain-texting).
 *   - The emitted URL is relative to the current page's directory-format URL,
 *     so it is base-path agnostic.
 *   - A `#fragment` is validated against the target's heading ids (anchorsOf);
 *     an unknown fragment is dropped, the link kept.
 *
 * The raw-markdown twin ([...slug].md.ts) serves the source verbatim, so the
 * authored `.md` relative links remain intact there for agents reading the
 * tree — this transform only affects the rendered HTML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, posix, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeForRel } from './routes';
import { anchorsOf } from './markdown-structure';
import { nativeImport } from './native-import';
import { discoverApiDescriptors } from './api-reference';

const CONTENT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'content',
);

function toContentRel(abs: string): string {
  return relative(CONTENT_ROOT, abs).split(sep).join('/');
}

function readSource(src: string): string {
  return readFileSync(src, 'utf8');
}

function slugOverrideOf(abs: string): string | undefined {
  const m = readSource(abs).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const slug = m?.[1].match(/^slug:\s*(.*)$/m)?.[1];
  return slug?.replace(/^["']|["']$/g, '').trim() || undefined;
}

/** Resolve a relative `.md` link target to an existing source file. */
function resolveTarget(fromDir: string, linkPath: string): string | null {
  const clean = decodeURI(linkPath);
  const abs = resolve(fromDir, clean);
  const candidates = clean.endsWith('/')
    ? [join(abs, 'README.md')]
    : [abs, `${abs}.md`, join(abs, 'README.md')];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

interface MdastNode {
  type: string;
  url?: string;
  children?: MdastNode[];
}

/* ── Generated routes ──────────────────────────────────────────────────
 * Generated pages (conformance + API reference) are loader entries, not
 * files. There is exactly ONE way to reference them: `<slug>.md` (with an
 * optional `./`) — the vocabulary every producer emits: authored pages,
 * the API index, and TypeDoc's cross-module links (modules are renamed to
 * their slugs before rendering). Conformance targets validate fragments
 * against the projection markdown; API targets pass fragments through
 * (TypeDoc owns its anchor model). */

interface GeneratedRoutes {
  slugs: Set<string>;
  /** conformance slug → page markdown (for fragment validation) */
  conformanceMarkdown: Map<string, string>;
}

let generatedRoutes: GeneratedRoutes | undefined;

async function loadGeneratedRoutes(): Promise<GeneratedRoutes> {
  if (generatedRoutes) return generatedRoutes;
  const slugs = new Set<string>();
  const conformanceMarkdown = new Map<string, string>();
  const { CONFORMANCE_DOCS_PAGES } =
    await nativeImport<typeof import('@pyric/cli/conformance/docs')>('@pyric/cli/conformance/docs');
  for (const page of CONFORMANCE_DOCS_PAGES) {
    slugs.add(page.slug);
    conformanceMarkdown.set(page.slug, page.markdown);
  }
  slugs.add('api-reference');
  for (const descriptor of discoverApiDescriptors()) {
    slugs.add(descriptor.slug);
  }
  generatedRoutes = { slugs, conformanceMarkdown };
  return generatedRoutes;
}

/** Exact match only: `<slug>.md` or `./<slug>.md`. Anything with directory
 * segments is not a generated reference. */
function generatedRouteFor(routes: GeneratedRoutes, linkPath: string): string | undefined {
  const clean = decodeURI(linkPath);
  const name = clean.startsWith('./') ? clean.slice(2) : clean;
  if (name.includes('/') || !name.endsWith('.md')) return undefined;
  const slug = name.slice(0, -'.md'.length);
  return routes.slugs.has(slug) ? slug : undefined;
}

interface VFile {
  path?: string;
  history?: string[];
}

export default function remarkDocLinks() {
  return async (tree: MdastNode, file: VFile) => {
    const routes = await loadGeneratedRoutes();
    const filePath = file.path ?? file.history?.[file.history.length - 1];
    // Loader-rendered pages (conformance, API reference) have no source file;
    // their links resolve against the generated route maps only, emitted as
    // site-absolute URLs (the composed site always serves at base '/').
    const fromUrlDir = filePath
      ? posix.join('/docs', routeForRel(toContentRel(filePath), slugOverrideOf(filePath)))
      : null;
    const fromDir = filePath ? dirname(filePath) : null;

    const visit = (node: MdastNode) => {
      if (node.type === 'link' && typeof node.url === 'string') {
        node.url = rewrite(routes, node.url, filePath ?? null, fromDir, fromUrlDir);
      }
      if (node.children) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}

function emit(fromUrlDir: string | null, targetRoute: string, fragment: string): string {
  const targetUrlDir = posix.join('/docs', targetRoute);
  if (fromUrlDir === null) return `${targetUrlDir}/${fragment}`;
  let rel = posix.relative(fromUrlDir, targetUrlDir);
  if (rel === '') rel = '.';
  return `${rel}/${fragment}`;
}

function rewrite(
  routes: GeneratedRoutes,
  url: string,
  filePath: string | null,
  fromDir: string | null,
  fromUrlDir: string | null,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // absolute scheme
  if (url.startsWith('#') || url.startsWith('/')) return url;
  const [path, rawFragment] = url.split('#');
  if (!/\.md$/.test(path)) return url; // only `.md` links are rewritten

  // Generated targets first: they have no file to resolve against.
  const generatedRoute = generatedRouteFor(routes, path);
  if (generatedRoute) {
    let fragment = '';
    if (rawFragment) {
      const frag = rawFragment.replace(/^user-content-/, '');
      const markdown = routes.conformanceMarkdown.get(generatedRoute);
      if (markdown === undefined) {
        fragment = `#${frag}`; // API pages: TypeDoc owns its anchor model
      } else if (anchorsOf(generatedRoute, () => markdown).has(frag)) {
        fragment = `#${frag}`;
      }
    }
    return emit(fromUrlDir, generatedRoute, fragment);
  }

  if (fromDir === null || filePath === null) {
    throw new Error(
      `broken doc link in a generated page: '${url}' names no generated route`,
    );
  }
  const target = resolveTarget(fromDir, path);
  if (!target) {
    throw new Error(
      `broken doc link in ${toContentRel(filePath)}: '${url}' resolves to no file under src/content`,
    );
  }
  const targetRoute = routeForRel(toContentRel(target), slugOverrideOf(target));
  let fragment = '';
  if (rawFragment) {
    const frag = rawFragment.replace(/^user-content-/, '');
    if (anchorsOf(target, readSource).has(frag)) fragment = `#${frag}`;
  }
  return emit(fromUrlDir, targetRoute, fragment);
}
