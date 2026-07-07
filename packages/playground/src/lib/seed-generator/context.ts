/**
 * Build compact workspace context for AI seed generation.
 */
import type { SeedUser } from 'pyric/auth';

import { deriveIdentities } from '~/lib/agent/spec/derive';
import { readAppSpecFromVfs, SPEC_PATH } from '~/lib/conformance/conformance-check';
import type { AppSpecV1 } from '~/lib/agent/spec/schema';
import { readFirestoreState } from '~/lib/sandbox/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { TESTS_DIR } from '~/lib/tools/core/runWorkspaceTests';
import { getVFS } from '~/lib/vfs';

const MAX_RULES_CHARS = 1200;
const MAX_APP_CHARS = 800;
const MAX_PAYLOAD_CHARS = 4000;

export interface SeedContextSummary {
  hasSpec: boolean;
  hasRules: boolean;
  hasApp: boolean;
  hasTests: boolean;
}

export interface SeedContextBundle {
  summary: SeedContextSummary;
  /** JSON string fed to the model as user context. */
  payload: string;
  spec: AppSpecV1 | null;
  authoritativeIdentities: SeedUser[] | null;
}

export interface BuildSeedContextOpts {
  hint?: string;
  readFile?: (path: string) => Promise<string | null>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

function collectionNameFromPath(path: string): string {
  const seg = path.split('/')[0]?.trim();
  return seg ?? path;
}

/** Extract root collection names from firestore.rules match blocks. */
export function extractCollectionNamesFromRules(rules: string): string[] {
  const seen = new Set<string>();
  for (const m of rules.matchAll(/match\s+\/([^{/\s]+)/g)) {
    const name = m[1]?.trim();
    if (name && name !== 'databases') seen.add(name);
  }
  return [...seen].sort();
}

/** Extract collection() first-arg strings from App TSX. */
export function extractCollectionNamesFromApp(appSource: string): string[] {
  const seen = new Set<string>();
  for (const m of appSource.matchAll(/collection\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/g)) {
    seen.add(m[1]!);
  }
  return [...seen].sort();
}

function rootCollectionIds(state: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const path of Object.keys(state)) {
    const first = path.split('/', 1)[0];
    if (first) seen.add(first);
  }
  return [...seen].sort();
}

async function readTestSeeds(
  readFile: (path: string) => Promise<string | null>,
): Promise<Array<{ file: string; seed: unknown[] }>> {
  const vfs = getVFS();
  let entries: string[] = [];
  try {
    entries = (await vfs.promises.readdir(TESTS_DIR)) as string[];
  } catch {
    return [];
  }
  const out: Array<{ file: string; seed: unknown[] }> = [];
  for (const name of entries) {
    if (!name.endsWith('.test.json')) continue;
    const content = await readFile(`${TESTS_DIR}/${name}`);
    if (!content?.trim()) continue;
    try {
      const parsed = JSON.parse(content) as { seed?: unknown[] };
      if (Array.isArray(parsed.seed) && parsed.seed.length > 0) {
        out.push({ file: name, seed: parsed.seed.slice(0, 5) });
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

async function defaultReadFile(path: string): Promise<string | null> {
  try {
    const raw = await getVFS().promises.readFile(path);
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/** Assemble context from workspace + sandbox for the seed generator. */
export async function buildSeedContextBundle(
  opts: BuildSeedContextOpts = {},
): Promise<SeedContextBundle> {
  const readFile = opts.readFile ?? defaultReadFile;
  const { rules, appSource } = useWorkspaceStore.getState();
  const spec = await readAppSpecFromVfs(readFile, SPEC_PATH);
  const testSeeds = await readTestSeeds(readFile);
  const rulesCollections = extractCollectionNamesFromRules(rules);
  const appCollections = extractCollectionNamesFromApp(appSource);
  const existingCollections = rootCollectionIds(await readFirestoreState());

  const authoritativeIdentities = spec ? deriveIdentities(spec) : null;

  const contextObj: Record<string, unknown> = {
    userHint: opts.hint?.trim() || undefined,
    spec: spec
      ? {
          title: spec.meta.title,
          assumptions: spec.meta.assumptions?.slice(0, 4),
          collections: spec.collections.map((c) => ({
            name: collectionNameFromPath(c.path),
            path: c.path,
            fields: c.fields.map((f) => ({
              name: f.name,
              type: f.type,
              required: f.required,
              enum: f.enum,
            })),
            ownerField: c.ownerField,
          })),
          identities: spec.identities.map((i) => ({
            uid: i.uid,
            description: i.description,
            claims: i.claims,
          })),
        }
      : undefined,
    authoritativeIdentities: authoritativeIdentities ?? undefined,
    rulesCollections,
    rulesExcerpt: rules.trim() ? truncate(rules, MAX_RULES_CHARS) : undefined,
    appCollections,
    appExcerpt: appSource.trim() ? truncate(appSource, MAX_APP_CHARS) : undefined,
    testSeeds: testSeeds.length > 0 ? testSeeds : undefined,
    existingCollections: existingCollections.length > 0 ? existingCollections : undefined,
  };

  let payload = JSON.stringify(contextObj, null, 2);
  if (payload.length > MAX_PAYLOAD_CHARS) {
    payload = `${payload.slice(0, MAX_PAYLOAD_CHARS)}\n…(truncated)`;
  }

  return {
    summary: {
      hasSpec: spec !== null,
      hasRules: rules.trim().length > 0,
      hasApp: appSource.trim().length > 0,
      hasTests: testSeeds.length > 0,
    },
    payload,
    spec,
    authoritativeIdentities,
  };
}
