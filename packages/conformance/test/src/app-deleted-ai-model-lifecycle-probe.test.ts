import { describe, expect, test } from 'bun:test';
import { FirebaseError } from 'firebase/app';
import { AIError, AIErrorCode } from 'firebase/ai';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import {
  classifyDeletedAiError,
  observeDeletedAppAiModelLifecycle,
  probe as deletedAppAiLifecycleProbe,
  type DeletedAiErrorFacts,
  type DeletedAiLifecycleErrorClassifier,
  type DeletedAiProbeModelSubject,
  type DeletedAppAiLifecycleDriver,
} from '../../probes/app/app-production-deleted-ai-model-lifecycle.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const STAGED_PROBE_ID = 'app-production-deleted-ai-model-lifecycle';

const classifier: DeletedAiLifecycleErrorClassifier = {
  isAIError: (err) => err instanceof AIError,
  isFirebaseError: (err) => err instanceof FirebaseError,
};

function createHealthyModel(): DeletedAiProbeModelSubject {
  return {
    async countTokens() {
      return { totalTokens: 9 };
    },
    async generateContent() {
      return {
        response: {
          text: () => 'alpha',
          candidates: [{ finishReason: 'STOP' }],
        },
      };
    },
    async generateContentStream() {
      async function* chunks() {
        yield { text: () => '1 2 ', candidates: [] };
        yield { text: () => '3 4 5', candidates: [{ finishReason: 'STOP' }] };
      }
      return {
        stream: chunks(),
        response: Promise.resolve({
          text: () => '1 2 3 4 5',
          candidates: [{ finishReason: 'STOP' }],
        }),
      };
    },
  };
}

function createRejectingModel(makeError: () => Error): DeletedAiProbeModelSubject {
  return {
    async countTokens() {
      throw makeError();
    },
    async generateContent() {
      throw makeError();
    },
    async generateContentStream() {
      async function* failingChunks(): AsyncGenerator<{ text(): string }> {
        yield* [];
        throw makeError();
      }
      return {
        stream: failingChunks(),
        response: Promise.reject(makeError()),
      };
    },
  };
}

describe('app#27 staged sdk-probes capture (app-production-deleted-ai-model-lifecycle)', () => {
  test('registers under sdk-probes with expectStagedUntilCaptured and validates PR #1 and PR #2 states', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(STAGED_PROBE_ID);

    expect(deletedAppAiLifecycleProbe.rig).toBe('sdk-probes');
    expect(deletedAppAiLifecycleProbe.requires).toEqual(['web-config']);
    expect(deletedAppAiLifecycleProbe.pendingRowLink).toBe(true);
    expect(deletedAppAiLifecycleProbe.matrixRow).toBe('');
    expect(deletedAppAiLifecycleProbe.rowIds).toEqual([]);
    expect(deletedAppAiLifecycleProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(STAGED_PROBE_ID, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const explicitSelected = selectModularProbes(
      loaded,
      ['--write', '--probe', STAGED_PROBE_ID],
      'sdk-probes',
      { includeUncapturedStaged: false },
    );
    expect(explicitSelected.map((entry) => entry.id)).toEqual([STAGED_PROBE_ID]);

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(
      previewLines.some(
        (line) =>
          line.includes(STAGED_PROBE_ID) &&
          line.includes('observations/app/app-production-deleted-ai-model-lifecycle.json') &&
          line.includes('[pendingRowLink]'),
      ),
    ).toBe(true);

    const rigManifests = await loadRigManifests();
    const existingObservations = loadObservations();
    const syntheticPr2Observation: Observation = {
      file: `${STAGED_PROBE_ID}.json`,
      surfaceDir: 'app',
      name: STAGED_PROBE_ID,
      matrixRow: '',
      rowIds: [],
      observedAt: '2026-11-20T00:00:00.000Z',
      fbSdkVersion: '12.19.0',
      behavior: { sample: true },
      raw: { fbSdkVersion: '12.19.0', rowIds: [] },
    };
    const pr2Observations = [
      ...existingObservations.filter((obs) => obs.name !== STAGED_PROBE_ID),
      syntheticPr2Observation,
    ];
    const pr2Problems = validateCompatibilityRegistry({
      rows: allCompatibilityRows,
      descriptors: surfaceDescriptors,
      observations: pr2Observations,
      observationExceptions,
      rigManifests,
      probeFiles: listProbeFiles(),
      rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
      rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
      rulesRtdbScenarioIds: [
        ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
        ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
      ],
    });
    expect(pr2Problems).toEqual([]);
  }, 30_000);

  test('records post-delete getGenerativeModel app/app-deleted throws alongside live retained and sibling model outcomes', async () => {
    interface FakeApp {
      readonly role: string;
      deleted: boolean;
      warmedAppCheck: boolean;
    }
    interface FakeAi {
      readonly app: FakeApp;
    }

    const aiByApp = new Map<FakeApp, FakeAi>();
    const driver: DeletedAppAiLifecycleDriver<FakeApp, FakeAi> = {
      hasGlobalIndexedDB: false,
      classifier,
      createApp(role) {
        return { role, deleted: false, warmedAppCheck: false };
      },
      async deleteApp(app) {
        app.deleted = true;
      },
      async activateAppCheck(app, warmBeforeUse) {
        app.warmedAppCheck = warmBeforeUse;
      },
      getAI(app) {
        let handle = aiByApp.get(app);
        if (!handle) {
          handle = { app };
          aiByApp.set(app, handle);
        }
        return handle;
      },
      aiAppOf(ai) {
        return ai.app;
      },
      getGenerativeModel(ai) {
        if (ai.app.deleted) {
          throw new FirebaseError(
            'app/app-deleted',
            `Firebase: Firebase App named '${ai.app.role}-secret-run' already deleted (app/app-deleted).`,
          );
        }
        return createHealthyModel();
      },
    };
    const observed = await observeDeletedAppAiModelLifecycle(driver);

    const serialized = JSON.stringify(observed);
    expect(serialized.includes('secret-run')).toBe(false);
    expect(observed).toEqual({
      model: 'gemini-flash-lite-latest',
      hasGlobalIndexedDB: false,
      postDeleteFactories: {
        getAIOnDeletedApp: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          usesTargetApp: true,
        },
        getGenerativeModelOnDeletedAppAI: {
          threw: true,
          isAIError: false,
          isFirebaseError: true,
          errorName: 'FirebaseError',
          code: 'app/app-deleted',
          status: null,
          mentionsAppDeleted: true,
        },
        getGenerativeModelOnRetainedAI: {
          threw: true,
          isAIError: false,
          isFirebaseError: true,
          errorName: 'FirebaseError',
          code: 'app/app-deleted',
          status: null,
          mentionsAppDeleted: true,
        },
      },
      equalConfigTopology: {
        equalConfigAppsDistinct: true,
        aiHandlesDistinct: true,
        aiHandlesCarryOwnApps: true,
      },
      retainedModelWithWarmAppCheck: {
        countTokens: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          hasTotalTokensKey: true,
          totalTokensIsPositiveInteger: true,
        },
        generateContent: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          finishReason: 'STOP',
          hasNonEmptyText: true,
        },
        generateContentStream: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          chunksYielded: 2,
          finishReason: 'STOP',
        },
      },
      retainedModelWithColdAppCheck: {
        countTokens: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          hasTotalTokensKey: true,
          totalTokensIsPositiveInteger: true,
        },
      },
      survivingEqualConfigSiblingModel: {
        countTokens: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          hasTotalTokensKey: true,
          totalTokensIsPositiveInteger: true,
        },
        generateContent: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          finishReason: 'STOP',
          hasNonEmptyText: true,
        },
        generateContentStream: {
          threw: false,
          isAIError: false,
          isFirebaseError: false,
          errorName: null,
          code: null,
          status: null,
          mentionsAppDeleted: false,
          chunksYielded: 2,
          finishReason: 'STOP',
        },
      },
    });
  });

  test('records tombstoned retainedModel rejections and redacts project URLs from AIError failures', async () => {
    interface FakeApp {
      readonly role: string;
      deleted: boolean;
      warmedAppCheck: boolean;
    }
    interface FakeAi {
      readonly app: FakeApp;
    }

    const makeWrappedDeleteError = () =>
      new AIError(
        AIErrorCode.ERROR,
        'Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/hidden-proj-id/models/gemini-flash-lite-latest:countTokens: Firebase: Firebase App named "cold-run" already deleted (app/app-deleted).',
      );
    const makeDirectDeleteError = () =>
      new FirebaseError('app/app-deleted', 'Firebase App has already been deleted.');

    const observed = await observeDeletedAppAiModelLifecycle<FakeApp, FakeAi>({
      hasGlobalIndexedDB: true,
      classifier,
      createApp(role) {
        return { role, deleted: false, warmedAppCheck: false };
      },
      async deleteApp(app) {
        app.deleted = true;
      },
      async activateAppCheck(app, warmBeforeUse) {
        app.warmedAppCheck = warmBeforeUse;
      },
      getAI(app) {
        return { app };
      },
      aiAppOf(ai) {
        return ai.app;
      },
      getGenerativeModel(ai) {
        if (ai.app.deleted) {
          throw makeDirectDeleteError();
        }
        if (ai.app.role === 'warm-retained-owner') {
          return createRejectingModel(makeDirectDeleteError);
        }
        if (ai.app.role === 'cold-retained-owner') {
          return createRejectingModel(makeWrappedDeleteError);
        }
        return createHealthyModel();
      },
    });

    const serialized = JSON.stringify(observed);
    expect(serialized.includes('hidden-proj-id')).toBe(false);
    expect(serialized.includes('cold-run')).toBe(false);
    expect(observed.retainedModelWithWarmAppCheck).toEqual({
      countTokens: {
        threw: true,
        isAIError: false,
        isFirebaseError: true,
        errorName: 'FirebaseError',
        code: 'app/app-deleted',
        status: null,
        mentionsAppDeleted: true,
        hasTotalTokensKey: false,
        totalTokensIsPositiveInteger: false,
      },
      generateContent: {
        threw: true,
        isAIError: false,
        isFirebaseError: true,
        errorName: 'FirebaseError',
        code: 'app/app-deleted',
        status: null,
        mentionsAppDeleted: true,
        finishReason: null,
        hasNonEmptyText: false,
      },
      generateContentStream: {
        threw: true,
        isAIError: false,
        isFirebaseError: true,
        errorName: 'FirebaseError',
        code: 'app/app-deleted',
        status: null,
        mentionsAppDeleted: true,
        chunksYielded: 0,
        finishReason: null,
      },
    });
    expect(observed.retainedModelWithColdAppCheck).toEqual({
      countTokens: {
        threw: true,
        isAIError: true,
        isFirebaseError: true,
        errorName: 'AIError',
        code: 'error',
        status: null,
        mentionsAppDeleted: true,
        hasTotalTokensKey: false,
        totalTokensIsPositiveInteger: false,
      },
    });

    const fetch401: DeletedAiErrorFacts = classifyDeletedAiError(
      new AIError(AIErrorCode.FETCH_ERROR, 'Unauthorized', { status: 401 }),
      classifier,
    );
    expect(fetch401).toEqual({
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      errorName: 'AIError',
      code: 'fetch-error',
      status: 401,
      mentionsAppDeleted: false,
    });
  });
});
