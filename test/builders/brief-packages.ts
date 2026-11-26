/**
 * Checks that a brief's features, target area, journey, and must-be-refused
 * actions only require packages the framework's starter (`test/builders/starters/<framework>/package.json`)
 * and the workspace's packed Pyric tarballs provide inside the offline sandbox (#1767).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Brief, Framework } from './brief.ts';

const DEFAULT_STARTERS_DIR = fileURLToPath(new URL('./starters', import.meta.url));

/** Workspace packages packed by `scripts/pack-packages.sh` and available offline in the sandbox. */
const PACKED_WORKSPACE_PACKAGES = new Set([
  'pyric',
  'pyric-admin',
  '@pyric/cli',
  '@pyric/rules',
  '@pyric/ui',
  '@pyric/live',
  'create-pyric',
]);

interface PackageRule {
  packageName: string;
  label: string;
  pattern: RegExp;
  /** When true, inspect `userJourney` and `mustBeRefused` actions in addition to `targetArea.area` and `features`. */
  checkAllFields: boolean;
}

const CLOUD_FUNCTIONS_IDENTIFIERS = [
  'onValueCreated',
  'onValueWritten',
  'onValueUpdated',
  'onValueDeleted',
  'onDocumentCreated',
  'onDocumentWritten',
  'onDocumentUpdated',
  'onDocumentDeleted',
  'onObjectFinalized',
  'onObjectArchived',
  'onObjectDeleted',
  'onObjectMetadataUpdated',
  'onRequest',
  'onCall',
  'onSchedule',
  'onMessagePublished',
  'beforeUserCreated',
  'beforeUserSignedIn',
].join('|');

const PACKAGE_RULES: readonly PackageRule[] = [
  {
    packageName: 'firebase-functions',
    label: 'Cloud Functions trigger or API',
    pattern: new RegExp(`\\b(${CLOUD_FUNCTIONS_IDENTIFIERS})\\b`),
    checkAllFields: true,
  },
  {
    packageName: 'firebase-functions',
    label: 'Cloud Functions',
    pattern: /\bcloud functions?\b/i,
    checkAllFields: false,
  },
  {
    packageName: '@firebase/rules-unit-testing',
    label: 'initializeTestEnvironment',
    pattern: /\binitializeTestEnvironment\b/,
    checkAllFields: true,
  },
  {
    packageName: 'next',
    label: 'Next.js',
    pattern: /\bnext(?:\.js|\/[a-z0-9-]+)\b/i,
    checkAllFields: false,
  },
  {
    packageName: 'react',
    label: 'React',
    pattern: /\breact(?:-dom)?\b/i,
    checkAllFields: false,
  },
  {
    packageName: 'express',
    label: 'Express',
    pattern: /\bexpress\b/i,
    checkAllFields: false,
  },
  {
    packageName: 'fastify',
    label: 'Fastify',
    pattern: /\bfastify\b/i,
    checkAllFields: false,
  },
  {
    packageName: 'hono',
    label: 'Hono',
    pattern: /\bhono\b/i,
    checkAllFields: false,
  },
];

const SCOPED_PACKAGE_RE = /(?<![a-z0-9@/._-])(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?![a-z0-9._-])/gi;
const FIREBASE_SUBPACKAGE_RE = /(?<![a-z0-9@/._-])(firebase-[a-z0-9][a-z0-9-]*)(?![a-z0-9._-])/gi;
const NON_PACKAGE_TOKENS = new Set(['firebase-config', 'firebase-tools']);

interface StarterManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Packages available inside the sandbox for `framework`: its starter dependencies plus packed Pyric packages. */
export function starterAvailablePackages(framework: Framework, startersDir: string = DEFAULT_STARTERS_DIR): Set<string> {
  const available = new Set<string>(PACKED_WORKSPACE_PACKAGES);
  const manifestPath = join(startersDir, framework, 'package.json');
  if (!existsSync(manifestPath)) return available;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StarterManifest;
  for (const name of Object.keys(manifest.dependencies ?? {})) available.add(name);
  for (const name of Object.keys(manifest.devDependencies ?? {})) available.add(name);
  return available;
}

function isAvailable(packageName: string, available: ReadonlySet<string>): boolean {
  const lower = packageName.toLowerCase();
  if (available.has(lower)) return true;
  if (lower.startsWith('@pyric/')) return PACKED_WORKSPACE_PACKAGES.has(lower);
  if (lower.startsWith('@firebase/') && lower !== '@firebase/rules-unit-testing') {
    return available.has('firebase');
  }
  return false;
}

function explicitPackagesIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SCOPED_PACKAGE_RE)) {
    const pkg = (match[1] ?? '').toLowerCase();
    if (pkg !== '') found.add(pkg);
  }
  for (const match of text.matchAll(FIREBASE_SUBPACKAGE_RE)) {
    const pkg = (match[1] ?? '').toLowerCase();
    if (pkg !== '' && !NON_PACKAGE_TOKENS.has(pkg)) found.add(pkg);
  }
  return [...found];
}

function functionsDocUrl(url: string): boolean {
  return url.toLowerCase().startsWith('https://firebase.google.com/docs/functions');
}

/**
 * Returns one error per missing package required by `brief`'s target area,
 * features, journey, or must-be-refused entries.
 */
export function briefPackageProblems(brief: Brief, startersDir: string = DEFAULT_STARTERS_DIR): string[] {
  const available = starterAvailablePackages(brief.framework, startersDir);
  const missing = new Map<string, string>();
  const primaryTexts = [brief.targetArea.area, ...brief.features];
  const allTexts = [...primaryTexts, ...brief.userJourney, ...brief.mustBeRefused.map((item) => item.action)];

  for (const rule of PACKAGE_RULES) {
    if (isAvailable(rule.packageName, available)) continue;
    const candidates = rule.checkAllFields ? allTexts : primaryTexts;
    const hit = candidates.find((entry) => rule.pattern.test(entry));
    if (hit !== undefined && !missing.has(rule.packageName)) {
      missing.set(rule.packageName, `${rule.label} in "${hit}"`);
    }
  }

  if (!isAvailable('vite', available)) {
    const viteFeature = brief.features.find((feature) => /\bvite\b/i.test(feature));
    if (viteFeature !== undefined && !missing.has('vite')) {
      missing.set('vite', `Vite in "${viteFeature}"`);
    }
  }

  if (!isAvailable('firebase-functions', available)) {
    const fnDoc = brief.mustBeRefused.find((item) => functionsDocUrl(item.firebaseDoc));
    if (fnDoc !== undefined && !missing.has('firebase-functions')) {
      missing.set('firebase-functions', `Cloud Functions doc "${fnDoc.firebaseDoc}"`);
    }
  }

  for (const entry of primaryTexts) {
    for (const pkg of explicitPackagesIn(entry)) {
      if (!isAvailable(pkg, available) && !missing.has(pkg)) {
        missing.set(pkg, `"${entry}"`);
      }
    }
  }

  return [...missing].map(
    ([pkg, reason]) => `brief ${brief.id}: requires package "${pkg}" (${reason}), which starter "${brief.framework}" does not install`,
  );
}
