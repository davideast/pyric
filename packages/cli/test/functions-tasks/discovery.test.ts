/**
 * Unit tests for `firebase-functions/v2/tasks` (`onTaskDispatched`) discovery,
 * option validation, and queue resource-name resolution.
 */
import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  discoverTasksTriggers,
  inspectTasksTriggers,
  parseQueueTargetName,
  resolveDiscoveredTaskTrigger,
  tasksTriggersFamily,
  validateTasksRateLimits,
  validateTasksRetryConfig,
} from '../../src/functions/tasks/discovery.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const { onRequest } = requireFromConformance(
  'firebase-functions/v2/https',
) as typeof import('firebase-functions/v2/https');
const { onTaskDispatched } = requireFromConformance(
  'firebase-functions/v2/tasks',
) as typeof import('firebase-functions/v2/tasks');

describe('functions/tasks discovery', () => {
  it('discovers real v2 onTaskDispatched exports with default RESET_VALUE fields unwrapped', () => {
    const basicTask = onTaskDispatched(() => {});
    const configuredTask = onTaskDispatched(
      {
        region: 'europe-west1',
        timeoutSeconds: 300,
        invoker: 'private',
        retryConfig: {
          maxAttempts: 5,
          maxRetrySeconds: 120,
          minBackoffSeconds: 2,
          maxBackoffSeconds: 30,
          maxDoublings: 4,
        },
        rateLimits: {
          maxConcurrentDispatches: 10,
          maxDispatchesPerSecond: 25,
        },
      },
      () => {},
    );
    const unrelatedHttp = onRequest((_req, res) => {
      res.send('ok');
    });

    const exported = {
      basicTask,
      billing: {
        configuredTask,
      },
      unrelatedHttp,
    };

    const inspection = inspectTasksTriggers(exported);
    expect(inspection.unsupported).toEqual([]);
    expect(inspection.triggers).toHaveLength(2);

    const first = inspection.triggers.find((t) => t.exportName === 'basicTask');
    expect(first).toBeDefined();
    expect(first?.region).toBe('us-central1');
    expect(first?.retryConfig).toEqual({});
    expect(first?.rateLimits).toEqual({});

    const second = inspection.triggers.find((t) => t.exportName === 'billing-configuredTask');
    expect(second).toBeDefined();
    expect(second?.region).toBe('europe-west1');
    expect(second?.location).toBe('europe-west1');
    expect(second?.timeoutSeconds).toBe(300);
    expect(second?.invoker).toEqual(['private']);
    expect(second?.retryConfig).toEqual({
      maxAttempts: 5,
      maxRetrySeconds: 120,
      minBackoffSeconds: 2,
      maxBackoffSeconds: 30,
      maxDoublings: 4,
    });
    expect(second?.rateLimits).toEqual({
      maxConcurrentDispatches: 10,
      maxDispatchesPerSecond: 25,
    });
  });

  it('classifies omitted, gcfv1, dynamic-expression, and invalid-option task exports', () => {
    const omitted = onTaskDispatched({ omit: true }, () => {});

    const v1Fake = Object.assign(() => {}, {
      __endpoint: {
        platform: 'gcfv1',
        taskQueueTrigger: {},
      },
    });

    const dynamicRetry = Object.assign(() => {}, {
      __endpoint: {
        platform: 'gcfv2',
        taskQueueTrigger: {
          retryConfig: {
            maxAttempts: { cel: '{{ params.ATTEMPTS }}' },
          },
        },
      },
    });

    const invalidBackoff = Object.assign(() => {}, {
      __endpoint: {
        platform: 'gcfv2',
        taskQueueTrigger: {
          retryConfig: {
            minBackoffSeconds: 60,
            maxBackoffSeconds: 10,
          },
        },
      },
    });

    const invalidRateLimits = Object.assign(() => {}, {
      __endpoint: {
        platform: 'gcfv2',
        taskQueueTrigger: {
          rateLimits: {
            maxConcurrentDispatches: 0,
          },
        },
      },
    });

    const invalidTimeout = Object.assign(() => {}, {
      __endpoint: {
        platform: 'gcfv2',
        timeoutSeconds: 3600,
        taskQueueTrigger: {},
      },
    });

    const exported = {
      omitted,
      v1Fake,
      dynamicRetry,
      invalidBackoff,
      invalidRateLimits,
      invalidTimeout,
    };

    const active = discoverTasksTriggers(exported);
    expect(active).toEqual([]);

    const unsupported = tasksTriggersFamily.unsupported(exported);
    expect(unsupported).toEqual([
      { exportName: 'omitted', eventType: 'task-queue (omitted from emulation)' },
      { exportName: 'v1Fake', eventType: 'task-queue (v1 taskQueue is not supported)' },
      {
        exportName: 'dynamicRetry',
        eventType: 'task-queue (unsupported dynamic retryConfig option)',
      },
      {
        exportName: 'invalidBackoff',
        eventType: 'task-queue (invalid retryConfig: minBackoffSeconds cannot exceed maxBackoffSeconds)',
      },
      {
        exportName: 'invalidRateLimits',
        eventType: 'task-queue (invalid rateLimits: maxConcurrentDispatches must be an integer >= 1)',
      },
      {
        exportName: 'invalidTimeout',
        eventType: 'task-queue (invalid timeoutSeconds option)',
      },
    ]);
  });

  it('validates duration strings and resolves bare, regional, project-qualified, and extension names', () => {
    const retryRes = validateTasksRetryConfig({
      maxAttempts: -1,
      minBackoffSeconds: '0.5s',
      maxBackoffSeconds: '10s',
      maxRetrySeconds: '60s',
      maxDoublings: 3,
    });
    expect(retryRes).toEqual({
      ok: true,
      retryConfig: {
        maxAttempts: -1,
        minBackoffSeconds: 0.5,
        maxBackoffSeconds: 10,
        maxRetrySeconds: 60,
        maxDoublings: 3,
      },
    });

    const badRate = validateTasksRateLimits({ maxDispatchesPerSecond: -5 });
    expect(badRate.ok).toBe(false);

    const triggers = discoverTasksTriggers({
      sendDigest: onTaskDispatched({ region: 'europe-west1' }, () => {}),
      'ext-resize-processImage': onTaskDispatched(() => {}),
      workers: {
        syncCatalog: onTaskDispatched(() => {}),
      },
    });

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName('locations/europe-west1/functions/sendDigest'),
        'proj-1',
      )?.exportName,
    ).toBe('sendDigest');

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName('locations/us-central1/functions/sendDigest'),
        'proj-1',
      ),
    ).toBeUndefined();

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName(
          'projects/proj-1/locations/europe-west1/functions/sendDigest',
        ),
        'proj-1',
      )?.exportName,
    ).toBe('sendDigest');

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName(
          'projects/wrong-proj/locations/europe-west1/functions/sendDigest',
        ),
        'proj-1',
      ),
    ).toBeUndefined();

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName('processImage', 'resize'),
      )?.exportName,
    ).toBe('ext-resize-processImage');

    expect(
      resolveDiscoveredTaskTrigger(
        triggers,
        parseQueueTargetName('workers.syncCatalog'),
      )?.exportName,
    ).toBe('workers-syncCatalog');
  });
});
