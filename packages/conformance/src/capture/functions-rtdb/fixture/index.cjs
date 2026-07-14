'use strict';

const { onValueCreated } = require('firebase-functions/v2/database');
const { logger } = require('firebase-functions');

const region = process.env.PYRIC_FUNCTIONS_RTDB_REGION || 'us-central1';
const instance = process.env.PYRIC_FUNCTIONS_RTDB_INSTANCE;
let runtime = {};
try {
  runtime = require('./runtime.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const options = (ref) => ({
  ref,
  region,
  ...(instance ? { instance } : {}),
  ...runtime,
  retry: false,
});

const envelope = (event) => ({
  idPresent: typeof event.id === 'string' && event.id.length > 0,
  type: event.type,
  subject: event.subject,
  timePresent: typeof event.time === 'string' && event.time.length > 0,
  instance: event.instance,
  location: event.location,
  ref: event.ref,
  params: event.params,
  authType: event.authType,
  authId: event.authId || null,
});

const snapshot = (data) => {
  const childKeys = [];
  data.forEach((child) => {
    childKeys.push(child.key);
  });
  return {
    val: data.val(),
    key: data.key,
    exists: data.exists(),
    toJSON: data.toJSON(),
    numChildren: data.numChildren(),
    childKeys,
    nestedEnabled: data.child('nested/enabled').val(),
    hasNestedEnabled: data.hasChild('nested/enabled'),
  };
};

const capture = (payload) => {
  logger.info('Pyric Functions RTDB oracle event', { pyricFunctionsRtdb: payload });
};

exports.pyricRtdbExactCreate = onValueCreated(
  options('/pyric_oracle/functions/{runId}/exact/target'),
  async (event) => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 750));
    const output = { completed: true, sourceKey: event.data.key };
    const outputRef = event.data.ref.parent.child('handler-write');
    await outputRef.set(output);
    capture({
      scenario: 'exact-lifecycle',
      runId: event.params.runId,
      event: envelope(event),
      snapshot: snapshot(event.data),
      handler: {
        awaitedMs: Date.now() - startedAt,
        adminRefKey: event.data.ref.key,
        adminRefPathMatchesEventRef: event.data.ref.toString().endsWith(`/${event.ref}`),
        outputRefKey: outputRef.key,
        adminWriteCompleted: true,
      },
    });
  },
);

exports.pyricRtdbWildcardCreate = onValueCreated(
  options('/pyric_oracle/functions/{runId}/wildcard/{caseId}/{itemId}'),
  async (event) => {
    capture({
      scenario: 'wildcard-batches',
      runId: event.params.runId,
      event: envelope(event),
      snapshot: snapshot(event.data),
    });
  },
);

exports.pyricRtdbDescendantCreate = onValueCreated(
  options('/pyric_oracle/functions/{runId}/descendant/leaf'),
  async (event) => {
    capture({
      scenario: 'descendant-projection',
      runId: event.params.runId,
      event: envelope(event),
      snapshot: snapshot(event.data),
    });
  },
);

exports.pyricRtdbStartupCreate = onValueCreated(
  options('/pyric_oracle/functions/{runId}/startup/target'),
  async (event) => {
    capture({
      scenario: 'startup-existing',
      runId: event.params.runId,
      event: envelope(event),
      snapshot: snapshot(event.data),
    });
  },
);

exports.pyricRtdbExpectedFailure = onValueCreated(
  options('/pyric_oracle/functions/{runId}/failure/target'),
  async (event) => {
    capture({
      scenario: 'failed-execution',
      runId: event.params.runId,
      event: envelope(event),
      snapshot: snapshot(event.data),
    });
    throw new Error('PYRIC_EXPECTED_ONVALUECREATED_FAILURE');
  },
);
