import type { SimulationContext, SimResource } from './evaluation-context.js';
import { EvalError } from './eval-error.js';
import { reviveFirestoreNumbers } from './firestore-values.js';
import { Path } from './wrappers/path.js';

/**
 * Sentinel returned by `SimulationContext.getDoc` for `exists()` when a document
 * is known to exist (for instance, from a partial update) while its full field
 * map was not captured, so `exists()` returns `true` without seeding a fake
 * document into `mockDocuments` for subsequent `get()` calls.
 */
export const EXISTS_ONLY_DOC: Readonly<Record<string, unknown>> = Object.freeze({
  __pyricExistsOnly: true,
});

/**
 * Check if a path or segment list points to a document (non-empty, even segment count).
 */
export function isDocumentPath(segmentsOrPath: string | readonly string[]): boolean {
  const segments = typeof segmentsOrPath === 'string'
    ? segmentsOrPath.split('/').filter(Boolean)
    : segmentsOrPath;
  if (segments.length === 0 || segments.length % 2 !== 0) return false;
  return !segments.some((seg) => /^\{.*\}$/.test(seg));
}

interface LookupPathInspection {
  readonly malformedDatabaseRoot: boolean;
  readonly foreignDatabase?: string;
  readonly foreignRelativePath?: string;
  readonly normalizedPath: string;
}

function resolveRelativeSegments(rawSegments: readonly string[]): string {
  const stack: string[] = [];
  for (const seg of rawSegments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (stack.length > 1) {
        stack.pop();
      }
      // When stack.length <= 1, .. is clamped to prevent escaping collection or document root.
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

function inspectLookupPath(rawPath: string, expectedDatabase?: string): LookupPathInspection {
  const targetDb = expectedDatabase && expectedDatabase.length > 0 ? expectedDatabase : '(default)';
  const cleaned = rawPath.replace(/\$\(database\)/g, targetDb);
  const beginsWithDatabases = /^\/*databases(?:\/|$)/.test(cleaned);
  const rawSegments = cleaned.split('/').filter((s) => s.length > 0);

  if (beginsWithDatabases) {
    if (
      rawSegments.length < 3 ||
      rawSegments[0] !== 'databases' ||
      rawSegments[1] === '.' ||
      rawSegments[1] === '..' ||
      rawSegments[2] !== 'documents'
    ) {
      return {
        malformedDatabaseRoot: true,
        normalizedPath: resolveRelativeSegments(rawSegments),
      };
    }
    if (rawSegments[1] !== targetDb) {
      return {
        malformedDatabaseRoot: false,
        foreignDatabase: rawSegments[1],
        foreignRelativePath: resolveRelativeSegments(rawSegments.slice(3)),
        normalizedPath: resolveRelativeSegments(rawSegments),
      };
    }
    return {
      malformedDatabaseRoot: false,
      normalizedPath: resolveRelativeSegments(rawSegments.slice(3)),
    };
  }

  return {
    malformedDatabaseRoot: false,
    normalizedPath: resolveRelativeSegments(rawSegments),
  };
}

export function isMalformedDatabaseLookupPath(
  rawPath: string,
  expectedDatabase?: string,
): boolean {
  return inspectLookupPath(rawPath, expectedDatabase).malformedDatabaseRoot;
}

export function nonDefaultDatabaseInLookupPath(
  rawPath: string,
  expectedDatabase?: string,
): string | undefined {
  return inspectLookupPath(rawPath, expectedDatabase).foreignDatabase;
}

export function normalizeDocumentPath(rawPath: string, expectedDatabase?: string): string {
  return inspectLookupPath(rawPath, expectedDatabase).normalizedPath;
}

/**
 * Canonical `/databases/<db>/documents/<rel>` key when `rawPath` names a valid
 * document inside a database other than `expectedDatabase`, or `undefined`.
 */
export function canonicalForeignLookupKey(
  rawPath: string,
  expectedDatabase?: string,
): string | undefined {
  const inspected = inspectLookupPath(rawPath, expectedDatabase);
  if (inspected.malformedDatabaseRoot || inspected.foreignDatabase === undefined) {
    return undefined;
  }
  const rel = inspected.foreignRelativePath ?? '';
  if (!isDocumentPath(rel.split('/').filter(Boolean))) {
    return undefined;
  }
  return `/databases/${inspected.foreignDatabase}/documents/${rel}`;
}

/** True when an explicit Rules Test API mock satisfies a cross-database lookup. */
export function hasForeignFunctionMock(
  fnName: 'get' | 'exists',
  rawPath: string,
  context: SimulationContext,
): boolean {
  const key = canonicalForeignLookupKey(rawPath, context.database);
  if (key === undefined) return false;
  if (fnName === 'get') {
    return context.foreignMockDocuments?.has(key) === true;
  }
  if (context.foreignExistsMocks?.has(key) === true) return true;
  return context.foreignMockDocuments?.has(key) === true;
}

/** Error wording for an unmocked cross-database document lookup. */
export function crossDatabaseLookupMessage(
  fnName: 'get' | 'exists' | 'getAfter' | 'existsAfter',
  foreignDatabase: string,
  expectedDatabase: string | undefined,
  rawPath: string,
): string {
  let targetDb = '(default)';
  if (expectedDatabase !== undefined && expectedDatabase.length > 0) {
    targetDb = expectedDatabase;
  }
  if (targetDb === '(default)') {
    return `${fnName}() cannot access non-default database '${foreignDatabase}' in path '${rawPath}'`;
  }
  return `${fnName}() cannot access database '${foreignDatabase}' from database '${targetDb}' in path '${rawPath}'`;
}

function validateAndNormalizeLookupPath(
  fnName: 'get' | 'exists',
  rawPath: string,
  expectedDatabase?: string,
): string {
  const inspected = inspectLookupPath(rawPath, expectedDatabase);
  if (inspected.malformedDatabaseRoot) {
    throw new EvalError(
      `${fnName}() requires a path rooted at '/databases/<database>/documents/...', got '${rawPath}'`,
    );
  }
  if (inspected.foreignDatabase !== undefined) {
    throw new EvalError(
      crossDatabaseLookupMessage(fnName, inspected.foreignDatabase, expectedDatabase, rawPath),
    );
  }
  const path = inspected.normalizedPath;
  const segments = path.split('/').filter(Boolean);
  if (!isDocumentPath(segments)) {
    throw new EvalError(
      `${fnName}() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  return path;
}

/** Build the identity-bearing value returned by a real document lookup. */
export function makeGetResource(
  relPath: string,
  data: Record<string, unknown>,
  database = '(default)',
): SimResource {
  const segments = relPath.split('/').filter(Boolean);
  const targetDb = database.length > 0 ? database : '(default)';
  return {
    data: reviveFirestoreNumbers(data) as Record<string, unknown>,
    id: segments.at(-1) ?? '',
    __name__: new Path(['databases', targetDb, 'documents', ...segments]),
  };
}

export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
  const foreignKey = canonicalForeignLookupKey(rawPath, context.database);
  if (foreignKey !== undefined) {
    const foreignDoc = context.foreignMockDocuments?.get(foreignKey);
    if (foreignDoc !== undefined) {
      return { data: reviveFirestoreNumbers(foreignDoc) as Record<string, unknown> };
    }
  }
  const path = validateAndNormalizeLookupPath('get', rawPath, context.database);
  let document = context.mockDocuments.get(path);
  if (!document && context.getDoc) {
    const loaded = context.getDoc(path, { kind: 'get', trace: context.trace });
    if (loaded && loaded !== EXISTS_ONLY_DOC) {
      const revived = reviveFirestoreNumbers(loaded) as Record<string, unknown>;
      context.mockDocuments.set(path, revived);
      document = revived;
    }
  }
  if (document) {
    const revivedDoc = reviveFirestoreNumbers(document) as Record<string, unknown>;
    if (context.identitylessFunctionMocks?.has(path)) {
      return { data: revivedDoc };
    }
    return makeGetResource(path, revivedDoc, context.database);
  }
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}

export function resolveExists(rawPath: string, context: SimulationContext): boolean {
  const foreignKey = canonicalForeignLookupKey(rawPath, context.database);
  if (foreignKey !== undefined) {
    const mockedForeign = context.foreignExistsMocks?.get(foreignKey);
    if (mockedForeign !== undefined) return mockedForeign;
    if (context.foreignMockDocuments?.has(foreignKey) === true) return true;
  }
  const path = validateAndNormalizeLookupPath('exists', rawPath, context.database);
  // An exists mock answers exists() first, whatever else is known about
  // the path (FS-CON-6).
  const mocked = context.existsMocks?.get(path);
  if (mocked !== undefined) return mocked;
  if (context.mockDocuments.has(path)) return true;
  if (context.getDoc) {
    const loaded = context.getDoc(path, { kind: 'exists', trace: context.trace });
    if (loaded) {
      if (loaded !== EXISTS_ONLY_DOC) {
        context.mockDocuments.set(path, reviveFirestoreNumbers(loaded) as Record<string, unknown>);
      }
      return true;
    }
  }
  return false;
}
