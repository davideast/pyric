/**
 * `Functions`, `TaskQueue`, and `getFunctions` implementation for `pyric-admin/functions`.
 */
import { ADMIN_APP_TARGET, type PyricAdminApp } from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { explicitProjectId } from '../app/project-id.js';
import { FirebaseFunctionsError, normalizeToFirebaseFunctionsError } from './error.js';
import { resolveTaskQueueDispatcher } from './local-task-store.js';
import {
  assertValidTaskId,
  parseFunctionQueueResource,
  validateEnqueueOptions,
} from './resource-name.js';
import type {
  NormalizedAdminTaskDelete,
  NormalizedAdminTaskEnqueue,
  TaskOptions,
} from './types.js';

const FUNCTIONS_INTERNAL_TOKEN = Symbol.for('pyric.admin.functions.internalToken');
const FUNCTIONS_INSTANCES = Symbol.for('pyric.admin.functions.instances');

interface GlobalFunctionsRegistry {
  [FUNCTIONS_INSTANCES]?: WeakMap<PyricAdminApp, Functions>;
}

function getInstancesMap(): WeakMap<PyricAdminApp, Functions> {
  const globalRecord = globalThis as GlobalFunctionsRegistry;
  if (globalRecord[FUNCTIONS_INSTANCES] === undefined) {
    globalRecord[FUNCTIONS_INSTANCES] = new WeakMap<PyricAdminApp, Functions>();
  }
  return globalRecord[FUNCTIONS_INSTANCES];
}

function resolveProjectIdForApp(app: PyricAdminApp): string | undefined {
  const explicit = explicitProjectId(app);
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const envProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (typeof envProject === 'string' && envProject.length > 0) {
    return envProject;
  }
  return undefined;
}

export class TaskQueue<Args = Record<string, unknown>> {
  readonly #app: PyricAdminApp;
  readonly #functionName: string;
  readonly #extensionId: string | undefined;

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== FUNCTIONS_INTERNAL_TOKEN) {
      const candidateName = args[0];
      if (typeof candidateName !== 'string' || candidateName.length === 0) {
        throw new FirebaseFunctionsError(
          'invalid-argument',
          '`functionName` must be a non-empty string.',
        );
      }
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'Must provide a valid FunctionsApiClient instance to create a new TaskQueue.',
      );
    }
    const app = args[1] as PyricAdminApp;
    const functionName = args[2];
    const extensionId = args[3];

    if (typeof functionName !== 'string' || functionName.length === 0) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        '`functionName` must be a non-empty string.',
      );
    }
    if (extensionId !== undefined && typeof extensionId !== 'string') {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        '`extensionId` must be a string.',
      );
    }

    this.#app = app;
    this.#functionName = functionName;
    this.#extensionId = extensionId;
  }

  async enqueue(data: Args, opts?: TaskOptions): Promise<void> {
    assertAdminAppActive(this.#app);
    const resource = parseFunctionQueueResource(this.#functionName, this.#extensionId);
    const validatedOpts = validateEnqueueOptions(opts);
    const dispatcher = resolveTaskQueueDispatcher(this.#app);
    const resolvedProject = resource.projectId ?? resolveProjectIdForApp(this.#app);

    const request: NormalizedAdminTaskEnqueue = {
      queueName: resource.resourceId,
      data,
    };
    if (resolvedProject !== undefined) {
      request.projectId = resolvedProject;
    }
    if (resource.locationId !== undefined) {
      request.locationId = resource.locationId;
    }
    if (this.#extensionId !== undefined) {
      request.extensionId = this.#extensionId;
    }
    if (validatedOpts.id !== undefined) {
      request.id = validatedOpts.id;
    }
    if (validatedOpts.scheduleDelaySeconds !== undefined) {
      request.scheduleDelaySeconds = validatedOpts.scheduleDelaySeconds;
    }
    if (validatedOpts.scheduleTimeIso !== undefined) {
      request.scheduleTimeIso = validatedOpts.scheduleTimeIso;
    }
    if (validatedOpts.dispatchDeadlineSeconds !== undefined) {
      request.dispatchDeadlineSeconds = validatedOpts.dispatchDeadlineSeconds;
    }
    if (validatedOpts.headers !== undefined) {
      request.headers = validatedOpts.headers;
    }
    if (validatedOpts.uri !== undefined) {
      request.uri = validatedOpts.uri;
    }

    try {
      await dispatcher.enqueue(request);
    } catch (err: unknown) {
      throw normalizeToFirebaseFunctionsError(err);
    }
  }

  async delete(id: string): Promise<void> {
    assertAdminAppActive(this.#app);
    const resource = parseFunctionQueueResource(this.#functionName, this.#extensionId);
    assertValidTaskId(id);
    const dispatcher = resolveTaskQueueDispatcher(this.#app);
    const resolvedProject = resource.projectId ?? resolveProjectIdForApp(this.#app);

    const request: NormalizedAdminTaskDelete = {
      queueName: resource.resourceId,
      id,
    };
    if (resolvedProject !== undefined) {
      request.projectId = resolvedProject;
    }
    if (resource.locationId !== undefined) {
      request.locationId = resource.locationId;
    }
    if (this.#extensionId !== undefined) {
      request.extensionId = this.#extensionId;
    }

    try {
      await dispatcher.delete(request);
    } catch (err: unknown) {
      throw normalizeToFirebaseFunctionsError(err);
    }
  }
}

export class Functions {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    if (args[0] !== FUNCTIONS_INTERNAL_TOKEN) {
      throw new FirebaseFunctionsError(
        'invalid-argument',
        'First argument passed to getFunctions() must be a valid Firebase app instance.',
      );
    }
    this.#app = args[1] as PyricAdminApp;
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  taskQueue<Args = Record<string, unknown>>(
    functionName: string,
    extensionId?: string,
  ): TaskQueue<Args> {
    assertAdminAppActive(this.#app);
    return new TaskQueue<Args>(
      FUNCTIONS_INTERNAL_TOKEN,
      this.#app,
      functionName,
      extensionId,
    );
  }
}

/** Resolve the per-app cached `Functions` service handle for `app` (or `[DEFAULT]`). */
export function getFunctions(app?: PyricAdminApp): Functions {
  const resolved = app === undefined ? getDefaultServiceApp() : app;
  if (
    resolved === null ||
    typeof resolved !== 'object' ||
    !(ADMIN_APP_TARGET in resolved) ||
    resolved[ADMIN_APP_TARGET] !== 'sandbox'
  ) {
    throw new FirebaseFunctionsError(
      'invalid-argument',
      'First argument passed to getFunctions() must be a valid Firebase app instance.',
    );
  }
  assertAdminAppActive(resolved);
  const instances = getInstancesMap();
  const existing = instances.get(resolved);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Functions(FUNCTIONS_INTERNAL_TOKEN, resolved);
  instances.set(resolved, created);
  return created;
}
