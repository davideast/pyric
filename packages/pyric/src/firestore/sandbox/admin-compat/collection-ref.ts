import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { generateAutoId, makeError } from 'pyric/sandbox/internal';
import { lastSegment } from './paths.js';
import { DocumentRefImpl } from './doc-ref.js';
import {
  FirestoreCompatError,
  type AuthContext,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type OperationOptions,
} from './types.js';
import { QueryImpl } from './query.js';

export function createDocumentRef(
  env: LocalEnvironment,
  auth: AuthContext,
  path: string,
  bypassRules: boolean,
): DocumentReference {
  return new DocumentRefImpl(
    env,
    auth,
    path,
    bypassRules,
    (collectionPath) => new CollectionRefImpl(env, auth, collectionPath, bypassRules),
  );
}

export class CollectionRefImpl extends QueryImpl implements CollectionReference {
  readonly id: string;
  readonly path: string;

  constructor(env: LocalEnvironment, auth: AuthContext, path: string, bypassRules: boolean = false) {
    super({
      env,
      auth,
      collectionPath: path,
      bypassRules,
      documentRef: (docPath) => createDocumentRef(env, auth, docPath, bypassRules),
    });
    this.path = path;
    this.id = lastSegment(path);
  }

  doc(id?: string): DocumentReference {
    const finalId = id ?? generateAutoId();
    return createDocumentRef(this.env, this.auth, `${this.path}/${finalId}`, this.bypassRules);
  }

  /** Mint an id and create the document through `createWithAutoId`, so the
   *  write event carries `autoId` and replay aliases it to a fresh mint
   *  (FS-MET-2). A minted id names an absent document, so the rules clause
   *  is `create`, as it was when this routed through `set`. */
  async add(data: DocumentData, opts?: OperationOptions): Promise<DocumentReference> {
    const auth = opts?.auth !== undefined ? opts.auth : this.auth;
    const { path, result } = this.env.createWithAutoId(this.path, data, auth, this.bypassRules);
    if (!result.allowed) {
      // The denial `DocumentReference.set` raised when `add` routed through it.
      if (result.error) throw new FirestoreCompatError(result.error);
      let msg = '(no debug message)';
      if (result.debugMessages.length > 0) msg = result.debugMessages.join('; ');
      throw new FirestoreCompatError(makeError('permission-denied', `set denied: ${msg}`));
    }
    return createDocumentRef(this.env, this.auth, path, this.bypassRules);
  }
}
