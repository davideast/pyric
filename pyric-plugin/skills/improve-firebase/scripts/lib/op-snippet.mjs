import { ContractValidationError, isReadOperationMethod } from './contracts.mjs';

const SERVICE_ALIASES = new Map([
  ['database', 'database'],
  ['rtdb', 'database'],
  ['realtime-database', 'database'],
  ['firestore', 'firestore'],
  ['cloud-firestore', 'firestore'],
  ['storage', 'storage'],
  ['cloud-storage', 'storage'],
  ['auth', 'auth'],
  ['authentication', 'auth'],
]);

/**
 * Normalizes a Firebase service name into one of Pyric's canonical service keys.
 *
 * @param {string} service
 * @returns {'database' | 'firestore' | 'storage' | 'auth'}
 */
export function normalizeServiceName(service) {
  if (typeof service !== 'string' || !service.trim()) {
    throw new ContractValidationError('Operation service must be a non-empty string');
  }
  const normalized = SERVICE_ALIASES.get(service.trim().toLowerCase());
  if (!normalized) {
    throw new ContractValidationError(
      `Unsupported Firebase service "${service}". Expected database/rtdb, firestore, storage, or auth.`,
    );
  }
  return normalized;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatJsValue(value, indent = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => formatJsValue(item, indent + 2));
    const singleLine = `[${items.join(', ')}]`;
    if (singleLine.length <= 60 && !singleLine.includes('\n')) {
      return singleLine;
    }
    const pad = ' '.repeat(indent + 2);
    const closePad = ' '.repeat(indent);
    return `[\n${items.map((item) => `${pad}${item}`).join(',\n')}\n${closePad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const pad = ' '.repeat(indent + 2);
    const closePad = ' '.repeat(indent);
    const lines = entries.map(([k, v]) => {
      const formattedKey = IDENTIFIER_RE.test(k) ? k : JSON.stringify(k);
      return `${pad}${formattedKey}: ${formatJsValue(v, indent + 2)}`;
    });
    return `{\n${lines.join(',\n')}\n${closePad}}`;
  }
  return JSON.stringify(value);
}

function normalizeRtdbPath(rawPath) {
  const cleaned = String(rawPath ?? '/').trim();
  if (!cleaned || cleaned === '/') return '/';
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

function normalizeFirestorePath(operation, expectCollection = false) {
  if (operation.path) {
    return String(operation.path).replace(/^\/+|\/+$/g, '');
  }
  if (operation.collection && operation.doc && !expectCollection) {
    const col = String(operation.collection).replace(/^\/+|\/+$/g, '');
    const docId = String(operation.doc).replace(/^\/+|\/+$/g, '');
    return `${col}/${docId}`;
  }
  if (operation.collection) {
    return String(operation.collection).replace(/^\/+|\/+$/g, '');
  }
  if (operation.doc) {
    return String(operation.doc).replace(/^\/+|\/+$/g, '');
  }
  return '';
}

function normalizeStoragePath(rawPath) {
  return String(rawPath ?? '').replace(/^\/+/, '');
}

function formatDatabaseSnippet(operation) {
  const method = String(operation.method || 'get').trim();
  const lower = method.toLowerCase();
  const targetPath = normalizeRtdbPath(operation.path);
  const refExpr = `ref(db, ${JSON.stringify(targetPath)})`;
  const payload =
    operation.data !== undefined
      ? operation.data
      : operation.value !== undefined
        ? operation.value
        : operation.values;

  if (lower === 'set' || lower === 'put' || lower === 'write') {
    return `await set(${refExpr}, ${formatJsValue(payload ?? null)});`;
  }
  if (lower === 'update' || lower === 'patch') {
    return `await update(${refExpr}, ${formatJsValue(payload ?? {})});`;
  }
  if (lower === 'push' || lower === 'post') {
    if (payload !== undefined) {
      return `await push(${refExpr}, ${formatJsValue(payload)});`;
    }
    return `await push(${refExpr});`;
  }
  if (lower === 'remove' || lower === 'delete' || lower === 'del') {
    return `await remove(${refExpr});`;
  }
  if (lower === 'get' || lower === 'read' || lower === 'once' || lower === 'onvalue' || lower === 'query') {
    const constraints = [];
    if (operation.query && typeof operation.query === 'object') {
      if (operation.query.orderByChild) {
        constraints.push(`orderByChild(${JSON.stringify(operation.query.orderByChild)})`);
      } else if (operation.query.orderByKey) {
        constraints.push('orderByKey()');
      } else if (operation.query.orderByValue) {
        constraints.push('orderByValue()');
      }
      if (operation.query.equalTo !== undefined) {
        constraints.push(`equalTo(${formatJsValue(operation.query.equalTo)})`);
      }
      if (operation.query.startAt !== undefined) {
        constraints.push(`startAt(${formatJsValue(operation.query.startAt)})`);
      }
      if (operation.query.endAt !== undefined) {
        constraints.push(`endAt(${formatJsValue(operation.query.endAt)})`);
      }
      if (operation.query.limitToFirst !== undefined) {
        constraints.push(`limitToFirst(${Number(operation.query.limitToFirst)})`);
      }
      if (operation.query.limitToLast !== undefined) {
        constraints.push(`limitToLast(${Number(operation.query.limitToLast)})`);
      }
    }
    if (constraints.length > 0) {
      return `await get(query(${refExpr}, ${constraints.join(', ')}));`;
    }
    return `await get(${refExpr});`;
  }

  throw new ContractValidationError(`Unsupported Realtime Database method "${method}"`);
}

function formatFirestoreSnippet(operation) {
  const method = String(operation.method || 'getDoc').trim();
  const lower = method.toLowerCase();
  const payload =
    operation.data !== undefined
      ? operation.data
      : operation.value !== undefined
        ? operation.value
        : operation.values;

  if (lower === 'set' || lower === 'setdoc' || lower === 'put' || lower === 'create') {
    const docPath = normalizeFirestorePath(operation, false);
    const docExpr = `doc(db, ${JSON.stringify(docPath)})`;
    const dataStr = formatJsValue(payload ?? {});
    if (operation.options && typeof operation.options === 'object' && Object.keys(operation.options).length > 0) {
      return `await setDoc(${docExpr}, ${dataStr}, ${formatJsValue(operation.options)});`;
    }
    return `await setDoc(${docExpr}, ${dataStr});`;
  }
  if (lower === 'update' || lower === 'updatedoc' || lower === 'patch') {
    const docPath = normalizeFirestorePath(operation, false);
    const docExpr = `doc(db, ${JSON.stringify(docPath)})`;
    return `await updateDoc(${docExpr}, ${formatJsValue(payload ?? {})});`;
  }
  if (lower === 'add' || lower === 'adddoc' || lower === 'post') {
    const colPath = normalizeFirestorePath(operation, true);
    const colExpr = `collection(db, ${JSON.stringify(colPath)})`;
    return `await addDoc(${colExpr}, ${formatJsValue(payload ?? {})});`;
  }
  if (lower === 'delete' || lower === 'deletedoc' || lower === 'remove') {
    const docPath = normalizeFirestorePath(operation, false);
    const docExpr = `doc(db, ${JSON.stringify(docPath)})`;
    return `await deleteDoc(${docExpr});`;
  }
  if (lower === 'get' || lower === 'getdoc' || lower === 'read') {
    const docPath = normalizeFirestorePath(operation, false);
    const docExpr = `doc(db, ${JSON.stringify(docPath)})`;
    return `await getDoc(${docExpr});`;
  }
  if (lower === 'getdocs' || lower === 'query' || lower === 'list') {
    const colPath = normalizeFirestorePath(operation, true);
    const colExpr = `collection(db, ${JSON.stringify(colPath)})`;
    if (Array.isArray(operation.query?.where) && operation.query.where.length > 0) {
      const clauses = operation.query.where.map(
        ([field, op, val]) => `where(${JSON.stringify(field)}, ${JSON.stringify(op)}, ${formatJsValue(val)})`,
      );
      return `await getDocs(query(${colExpr}, ${clauses.join(', ')}));`;
    }
    return `await getDocs(${colExpr});`;
  }

  throw new ContractValidationError(`Unsupported Firestore method "${method}"`);
}

function formatStorageSnippet(operation) {
  const method = String(operation.method || 'getBytes').trim();
  const lower = method.toLowerCase();
  const objectPath = normalizeStoragePath(operation.path);
  const refExpr = `ref(storage, ${JSON.stringify(objectPath)})`;

  if (lower === 'upload' || lower === 'uploadbytes' || lower === 'put' || lower === 'write' || lower === 'set') {
    const metadata =
      operation.metadata ||
      (operation.contentType ? { contentType: operation.contentType } : undefined);
    if (metadata && Object.keys(metadata).length > 0) {
      return `await uploadBytes(${refExpr}, file, ${formatJsValue(metadata)});`;
    }
    return `await uploadBytes(${refExpr}, file);`;
  }
  if (lower === 'uploadstring' || lower === 'putstring') {
    const text = typeof operation.data === 'string' ? operation.data : JSON.stringify(operation.data ?? '');
    return `await uploadString(${refExpr}, ${JSON.stringify(text)});`;
  }
  if (lower === 'get' || lower === 'getbytes' || lower === 'read') {
    return `await getBytes(${refExpr});`;
  }
  if (lower === 'getdownloadurl' || lower === 'download' || lower === 'url') {
    return `await getDownloadURL(${refExpr});`;
  }
  if (lower === 'delete' || lower === 'deleteobject' || lower === 'remove') {
    return `await deleteObject(${refExpr});`;
  }

  throw new ContractValidationError(`Unsupported Storage method "${method}"`);
}

function formatAuthSnippet(operation) {
  const method = String(operation.method || 'signInWithCustomToken').trim();
  const lower = method.toLowerCase();

  if (lower === 'signinwithemailandpassword') {
    const email = JSON.stringify(operation.email ?? operation.data?.email ?? 'user@example.com');
    const password = JSON.stringify(operation.password ?? operation.data?.password ?? 'password');
    return `await signInWithEmailAndPassword(auth, ${email}, ${password});`;
  }
  if (lower === 'createuserwithemailandpassword') {
    const email = JSON.stringify(operation.email ?? operation.data?.email ?? 'user@example.com');
    const password = JSON.stringify(operation.password ?? operation.data?.password ?? 'password');
    return `await createUserWithEmailAndPassword(auth, ${email}, ${password});`;
  }
  if (lower === 'signinwithcustomtoken') {
    return 'await signInWithCustomToken(auth, customToken);';
  }
  if (lower === 'signinanonymously') {
    return 'await signInAnonymously(auth);';
  }
  if (lower === 'signout') {
    return 'await signOut(auth);';
  }
  if (lower === 'updateprofile') {
    const profile = operation.data ?? { displayName: operation.displayName ?? 'User' };
    return `await updateProfile(auth.currentUser, ${formatJsValue(profile)});`;
  }

  throw new ContractValidationError(`Unsupported Auth method "${method}"`);
}

/**
 * Formats an operation descriptor into a clean, concise modular Firebase v9+ SDK snippet.
 *
 * @param {object} operation
 * @returns {string}
 */
export function formatSdkSnippet(operation) {
  if (!operation || typeof operation !== 'object') {
    throw new ContractValidationError('Operation must be a non-null object');
  }
  const service = normalizeServiceName(operation.service);
  if (service === 'database') {
    return formatDatabaseSnippet(operation);
  }
  if (service === 'firestore') {
    return formatFirestoreSnippet(operation);
  }
  if (service === 'storage') {
    return formatStorageSnippet(operation);
  }
  return formatAuthSnippet(operation);
}

function collapseRuleWhitespace(expr, maxLen = 160) {
  const clean = String(expr || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

/**
 * Formats a long Firebase rule expression with a clause-aware head + tail summary
 * so both the entry guard (e.g. `auth != null`) and decisive tail predicate (e.g.
 * `speaker/uid == auth.uid`) remain visible in single-line rule comparison bars.
 *
 * @param {string} expr
 * @param {number} [maxLen=136]
 * @returns {string}
 */
export function formatRuleExpressionSummary(expr, maxLen = 136) {
  const clean = String(expr || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;

  const connector = ' ... ';
  const usable = Math.max(24, maxLen - connector.length);
  const headBudget = Math.max(18, Math.floor(usable * 0.36));
  const tailBudget = Math.max(24, usable - headBudget);

  let headEnd = headBudget;
  const minHead = Math.floor(headBudget * 0.55);
  for (let i = headBudget; i >= minHead; i -= 1) {
    const ch = clean[i];
    if (ch === ' ' || ch === '&' || ch === '|') {
      headEnd = i;
      break;
    }
  }
  const head = clean.slice(0, headEnd).trimEnd();

  let tailStart = Math.max(headEnd + 1, clean.length - tailBudget);
  const maxTailStart = Math.min(clean.length - 12, clean.length - Math.floor(tailBudget * 0.65));
  for (let i = tailStart; i <= maxTailStart; i += 1) {
    const ch = clean[i];
    if (ch === ' ' || ch === '&' || ch === '|' || ch === '(' || ch === '!') {
      tailStart = ch === ' ' ? i + 1 : i;
      break;
    }
  }
  const tail = clean.slice(tailStart).trimStart();

  return `${head}${connector}${tail}`;
}

function isWriteMethod(method = 'set') {
  return !isReadOperationMethod(method);
}

function extractFocusedRtdbRule(parsed, targetPath, method, maxLen = 136) {
  const root = parsed && typeof parsed.rules === 'object' && parsed.rules !== null ? parsed.rules : parsed;
  if (!root || typeof root !== 'object') return null;

  const segments = String(targetPath || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

  const ruleProp = isWriteMethod(method) ? '.write' : '.read';
  let cursor = root;
  let pathLabel = '';
  let deepestMatchedExpr = null;
  let deepestMatchedScope = '';

  if (typeof cursor[ruleProp] === 'string' || typeof cursor[ruleProp] === 'boolean') {
    deepestMatchedExpr = String(cursor[ruleProp]);
    deepestMatchedScope = '/';
  }

  for (const seg of segments) {
    if (!cursor || typeof cursor !== 'object') break;
    let nextKey = null;
    if (Object.prototype.hasOwnProperty.call(cursor, seg) && !seg.startsWith('.')) {
      nextKey = seg;
    } else {
      const wildcard = Object.keys(cursor).find((k) => k.startsWith('$'));
      if (wildcard) {
        nextKey = wildcard;
      }
    }
    if (!nextKey) break;
    cursor = cursor[nextKey];
    pathLabel = pathLabel ? `${pathLabel}/${nextKey}` : nextKey;
    if (cursor && typeof cursor === 'object' && (typeof cursor[ruleProp] === 'string' || typeof cursor[ruleProp] === 'boolean')) {
      deepestMatchedExpr = String(cursor[ruleProp]);
      deepestMatchedScope = pathLabel;
    }
  }

  if (deepestMatchedExpr !== null) {
    const shortScope = deepestMatchedScope
      .split('/')
      .slice(-2)
      .join('/');
    const maxRuleLen = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 136;
    const exprText =
      deepestMatchedExpr === 'true' || deepestMatchedExpr === 'false'
        ? deepestMatchedExpr
        : `"${deepestMatchedExpr.length <= maxRuleLen ? deepestMatchedExpr : formatRuleExpressionSummary(deepestMatchedExpr, maxRuleLen)}"`;
    return shortScope
      ? `${shortScope}: "${ruleProp}": ${exprText}`
      : `"${ruleProp}": ${exprText}`;
  }

  return null;
}

function extractFocusedTextRule(rawText, targetPath, method, maxLen = 160) {
  const cleaned = String(rawText || '').trim();
  if (!cleaned) return '';

  const segments = String(targetPath || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const wantWrite = isWriteMethod(method);
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));

  // Try to locate the match block mentioning one of the collection segments
  let anchorIdx = -1;
  for (let s = Math.max(0, segments.length - 2); s >= 0; s -= 1) {
    const seg = segments[s];
    if (!seg || seg.startsWith('{') || seg.startsWith('$')) continue;
    const found = lines.findIndex((l) => l.includes(`match `) && l.includes(seg));
    if (found !== -1) {
      anchorIdx = found;
      break;
    }
  }

  const searchSlice = anchorIdx !== -1 ? lines.slice(anchorIdx, anchorIdx + 12) : lines;
  const allowLine =
    searchSlice.find((l) =>
      wantWrite
        ? /^allow\s+(write|create|update|delete)\b/.test(l)
        : /^allow\s+(read|get|list)\b/.test(l),
    ) || searchSlice.find((l) => /^allow\s+/.test(l));

  if (anchorIdx !== -1 && allowLine) {
    const matchHeader = lines[anchorIdx].replace(/\{$/, '').trim();
    const rawCombined = `${matchHeader} -> ${allowLine}`;
    return rawCombined.length <= maxLen ? rawCombined : formatRuleExpressionSummary(rawCombined, maxLen);
  }
  if (allowLine) {
    return allowLine.length <= maxLen ? allowLine : formatRuleExpressionSummary(allowLine, maxLen);
  }
  return cleaned.length <= maxLen ? cleaned : formatRuleExpressionSummary(cleaned, maxLen);
}

function stripJsonCommentsAndTrailingCommas(input) {
  const src = String(input || '');
  let out = '';
  let inString = false;
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      } else if (ch === '\n' || ch === '\r') {
        out += ch;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  // Strip trailing commas before } or ] outside strings
  let clean = '';
  inString = false;
  escapeNext = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      clean += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      clean += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') {
        continue;
      }
    }
    clean += ch;
  }

  return clean;
}

/**
 * Parses JSON or JSONC (Firebase RTDB `database.rules.json` with `//` / `/* *\/` comments).
 *
 * @param {string} raw
 * @returns {unknown}
 */
export function parseJsonWithComments(raw) {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
}

/**
 * Extracts a concise, human-readable single-line rule expression focused on the
 * target path from raw RTDB JSON or Firestore/Storage `.rules` source.
 *
 * @param {string | object} rulesInput
 * @param {{ service?: string, method?: string, path?: string }} [operation]
 * @returns {string}
 */
export function extractFocusedRuleSnippet(rulesInput, operation = {}, options = {}) {
  if (rulesInput === null || rulesInput === undefined) return '';

  const rawText = typeof rulesInput === 'string' ? rulesInput.trim() : JSON.stringify(rulesInput);
  if (!rawText) return '';

  const maxLen =
    options && typeof options.maxLen === 'number' && Number.isFinite(options.maxLen)
      ? options.maxLen
      : 136;

  // Preserve already-concise single-line rule snippets authored explicitly by users
  if (
    typeof rulesInput === 'string' &&
    !rawText.includes('\n') &&
    rawText.length <= Math.max(165, maxLen) &&
    !rawText.startsWith('{')
  ) {
    return rawText;
  }

  const targetPath = operation?.path || '/';
  const method = operation?.method || 'set';

  if (typeof rulesInput === 'object' || rawText.startsWith('{') || rawText.startsWith('//') || rawText.startsWith('/*')) {
    try {
      const parsed = typeof rulesInput === 'object' ? rulesInput : parseJsonWithComments(rawText);
      const focused = extractFocusedRtdbRule(parsed, targetPath, method, maxLen);
      if (focused) return focused;
    } catch {
      // Fall through to text extraction
    }
  }

  return extractFocusedTextRule(rawText, targetPath, method, maxLen);
}
