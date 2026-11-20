import 'fake-indexeddb/auto';
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AIError, getAI, getGenerativeModel, type AI } from 'pyric/ai';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { CustomProvider, getToken, initializeAppCheck } from 'pyric/app-check';
import { observeDeletedAppAiModelLifecycle } from '../../../conformance/probes/app/app-production-deleted-ai-model-lifecycle.ts';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';

interface DeletedAiStreamObservation {
  readonly threw: boolean;
  readonly isAIError: boolean;
  readonly isFirebaseError: boolean;
  readonly errorName: string | null;
  readonly code: string | null;
  readonly status: number | null;
  readonly mentionsAppDeleted: boolean;
  readonly chunksYielded: number;
  readonly finishReason: string | null;
}

interface DeletedAiObservationBehavior {
  readonly model: string;
  readonly hasGlobalIndexedDB: boolean;
  readonly postDeleteFactories: Record<string, unknown>;
  readonly equalConfigTopology: Record<string, unknown>;
  readonly retainedModelWithWarmAppCheck: {
    readonly countTokens: Record<string, unknown>;
    readonly generateContent: Record<string, unknown>;
    readonly generateContentStream: DeletedAiStreamObservation;
  };
  readonly retainedModelWithColdAppCheck: {
    readonly countTokens: Record<string, unknown>;
  };
  readonly survivingEqualConfigSiblingModel: {
    readonly countTokens: Record<string, unknown>;
    readonly generateContent: Record<string, unknown>;
    readonly generateContentStream: DeletedAiStreamObservation;
  };
}

const observation = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../conformance/observations/app/app-production-deleted-ai-model-lifecycle.json',
    ),
    'utf8',
  ),
).behavior as DeletedAiObservationBehavior;

function stripStreamChunkCount(
  streamOutcome: DeletedAiStreamObservation,
): Omit<DeletedAiStreamObservation, 'chunksYielded'> {
  const { chunksYielded: _chunksYielded, ...rest } = streamOutcome;
  return rest;
}

beforeEach(async () => {
  await resetAppRegistryForTests();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

test('replays production deleted-app getAI, getGenerativeModel, retained-model, and sibling lifecycle', async () => {
  const options = {
    apiKey: 'fake-api-key',
    projectId: 'production-deleted-ai-oracle',
    appId: '1:100000000000:web:deletedaioracle',
  };

  const actual = (await observeDeletedAppAiModelLifecycle<FirebaseApp, AI>({
    hasGlobalIndexedDB: false,
    classifier: {
      isAIError: (err) => err instanceof AIError,
      isFirebaseError: (err) => err instanceof FirebaseError,
    },
    createApp(role: string) {
      return initializeApp({ ...options }, `oracle-ai-${role}`);
    },
    async deleteApp(app) {
      await deleteApp(app);
    },
    async activateAppCheck(app, warmBeforeUse) {
      const provider = new CustomProvider({
        async getToken() {
          return await mintAppCheckToken(
            { appId: options.appId, projectId: options.projectId },
            3600,
          );
        },
      });
      const appCheck = initializeAppCheck(app, {
        provider,
        isTokenAutoRefreshEnabled: false,
      });
      if (warmBeforeUse) {
        await getToken(appCheck);
      }
    },
    getAI(app) {
      return getAI(app);
    },
    aiAppOf(ai) {
      return ai.app;
    },
    getGenerativeModel(ai) {
      return getGenerativeModel(ai, { model: observation.model });
    },
  })) as unknown as DeletedAiObservationBehavior;

  expect(actual.model).toBe(observation.model);
  expect(actual.hasGlobalIndexedDB).toBe(observation.hasGlobalIndexedDB);
  expect(actual.postDeleteFactories).toEqual(observation.postDeleteFactories);
  expect(actual.equalConfigTopology).toEqual(observation.equalConfigTopology);

  expect(actual.retainedModelWithWarmAppCheck.countTokens).toEqual(
    observation.retainedModelWithWarmAppCheck.countTokens,
  );
  expect(actual.retainedModelWithWarmAppCheck.generateContent).toEqual(
    observation.retainedModelWithWarmAppCheck.generateContent,
  );
  expect(stripStreamChunkCount(actual.retainedModelWithWarmAppCheck.generateContentStream)).toEqual(
    stripStreamChunkCount(observation.retainedModelWithWarmAppCheck.generateContentStream),
  );
  expect(actual.retainedModelWithWarmAppCheck.generateContentStream.chunksYielded).toBeGreaterThan(0);

  expect(actual.retainedModelWithColdAppCheck).toEqual(observation.retainedModelWithColdAppCheck);

  expect(actual.survivingEqualConfigSiblingModel.countTokens).toEqual(
    observation.survivingEqualConfigSiblingModel.countTokens,
  );
  expect(actual.survivingEqualConfigSiblingModel.generateContent).toEqual(
    observation.survivingEqualConfigSiblingModel.generateContent,
  );
  expect(
    stripStreamChunkCount(actual.survivingEqualConfigSiblingModel.generateContentStream),
  ).toEqual(
    stripStreamChunkCount(observation.survivingEqualConfigSiblingModel.generateContentStream),
  );
  expect(
    actual.survivingEqualConfigSiblingModel.generateContentStream.chunksYielded,
  ).toBeGreaterThan(0);
});
