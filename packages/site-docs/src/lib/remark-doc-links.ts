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

interface VFile {
  path?: string;
  history?: string[];
}

export default function remarkDocLinks() {
  return (tree: MdastNode, file: VFile) => {
    const filePath = file.path ?? file.history?.[file.history.length - 1];
    if (!filePath) return;
    const fromRoute = routeForRel(toContentRel(filePath), slugOverrideOf(filePath));
    const fromDir = dirname(filePath);
    const fromUrlDir = posix.join('/docs', fromRoute);

    const visit = (node: MdastNode) => {
      if (node.type === 'link' && typeof node.url === 'string') {
        node.url = rewrite(node.url, filePath, fromDir, fromUrlDir);
      }
      if (node.children) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}

function rewrite(url: string, filePath: string, fromDir: string, fromUrlDir: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // absolute scheme
  if (url.startsWith('#') || url.startsWith('/')) return url;
  const [path, rawFragment] = url.split('#');
  if (!/\.md$/.test(path)) return url; // only authored .md links
  const target = resolveTarget(fromDir, path);
  if (!target) {
    // Authored pages may legitimately link into _generated/ (conformance
    // matrices, the API reference), but that directory only exists after the
    // generate step. A missing generated target is an environment problem,
    // not a broken authored link — say so.
    const intended = toContentRel(resolve(fromDir, decodeURI(path)));
    if (intended.startsWith('_generated/')) {
      throw new Error(
        `generated content missing (run \`bun run generate\` in packages/site-docs; requires built packages): '${url}' in ${toContentRel(filePath)}`,
      );
    }
    throw new Error(
      `broken doc link in ${toContentRel(filePath)}: '${url}' resolves to no file under src/content`,
    );
  }
  const targetRoute = routeForRel(toContentRel(target), slugOverrideOf(target));
  const targetUrlDir = posix.join('/docs', targetRoute);
  let rel = posix.relative(fromUrlDir, targetUrlDir);
  if (rel === '') rel = '.';
  let out = `${rel}/`;
  if (rawFragment) {
    const frag = rawFragment.replace(/^user-content-/, '');
    if (anchorsOf(target, readSource).has(frag)) out += `#${frag}`;
  }
  return out;
}
