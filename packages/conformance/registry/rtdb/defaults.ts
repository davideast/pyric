export const listenerPermissionDenied = { name: "Error", code: "PERMISSION_DENIED", message: "permission_denied at <path>: Client doesn't have permission to access the desired data." };

export const deniedListenerCancellations = {
  value: { synchronous: null, cancellations: [listenerPermissionDenied] },
  child_added: { synchronous: null, cancellations: [listenerPermissionDenied] },
  child_changed: { synchronous: null, cancellations: [listenerPermissionDenied] },
  child_removed: { synchronous: null, cancellations: [listenerPermissionDenied] },
  child_moved: { synchronous: null, cancellations: [listenerPermissionDenied] },
};

export const revokedListenerCancellations = {
  deliveryCounts: { value: 1, child_added: 1, child_changed: 0, child_removed: 0, child_moved: 0 },
  cancellations: {
    value: [listenerPermissionDenied],
    child_added: [listenerPermissionDenied],
    child_changed: [listenerPermissionDenied],
    child_removed: [listenerPermissionDenied],
    child_moved: [listenerPermissionDenied],
  },
};

export const cddLifecycleTests = ["packages/pyric/test/database/cdd/lifecycle-and-identity.test.ts"];

export const cddPublicOperationTests = ["packages/pyric/test/database/cdd/public-operations.test.ts"];

export const updatesCaptureTests = ["packages/pyric/test/database/cdd/capture-updates-sentinels-and-validate.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-updates-sentinels-and-validate.test.ts"];

export const listenersCaptureTests = ["packages/pyric/test/database/cdd/capture-listeners-and-unsubscribe.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-listeners-and-unsubscribe.test.ts"];

export const atomsPoliciesCaptureTests = ["packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-atoms-and-policies.test.ts"];
