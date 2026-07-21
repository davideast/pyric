import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { generateAutoId } from 'pyric/sandbox/internal';
import { lastSegment } from './paths.js';
import { DocumentRefImpl } from './doc-ref.js';
import type {
  AuthContext,
  CollectionReference,
  DocumentData,
  DocumentReference,
  OperationOptions,
} from './types.js';
import { QueryImpl } from './query.js';

export class CollectionRefImpl extends QueryImpl implements CollectionReference {
  readonly id: string;
  readonly path: string;

  constructor(env: LocalEnvironment, auth: AuthContext, path: string, bypassRules: boolean = false) {
    super(
      env,
      auth,
      path,
      [],
      [],
      undefined,
      false,
      undefined,
      undefined,
      bypassRules,
      (docPath) => new DocumentRefImpl(env, auth, docPath, bypassRules),
    );
    this.path = path;
    this.id = lastSegment(path);
  }

  doc(id?: string): DocumentReference {
    const finalId = id ?? generateAutoId();
    return new DocumentRefImpl(this.env, this.auth, `${this.path}/${finalId}`, this.bypassRules);
  }

  async add(data: DocumentData, opts?: OperationOptions): Promise<DocumentReference> {
    const ref = this.doc();
    await ref.set(data, opts);
    return ref;
  }
}
