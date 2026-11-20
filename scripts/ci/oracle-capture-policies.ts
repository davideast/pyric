/**
 * Per-rig WIF tier, filter flag, staged push safety, and GCP IAM hint policies
 * for `.github/workflows/oracle-capture.yml`.
 */

export interface RigIamHint {
  permission: string;
  role: string;
  api: string;
}

export interface RigCapturePolicy {
  readonlyParityWif?: boolean;
  filterFlag?: '--scenario' | '--probe';
  autoPushSafe?: boolean;
  perProbeStaged?: boolean;
  iamHint?: RigIamHint;
}

const RULES_VIEWER_IAM_HINT: RigIamHint = {
  permission: 'firebaserules.rulesets.test',
  role: 'roles/firebaserules.viewer',
  api: 'firebaserules.googleapis.com',
};

const LIVE_SDK_IAM_HINT: RigIamHint = {
  permission:
    'firebase.projects.get, firebase.clients.list, firebase.clients.get, datastore.entities.create, firebaserules.releases.update, firebasedatabase.instances.update',
  role: 'roles/firebase.viewer, roles/datastore.user, roles/firebaserules.admin, roles/firebasedatabase.admin',
  api: 'firebase.googleapis.com, firestore.googleapis.com, firebaserules.googleapis.com, firebasedatabase.googleapis.com',
};

const EMPTY_POLICY: RigCapturePolicy = {};

/**
 * Consolidated per-rig policy table (`oracle-capture.yml`).
 *
 * Read-only Rules Test API rigs (`readonlyParityWif: true`) use the existing
 * `GCP_WIF_PROVIDER` + `PARITY_SA_EMAIL` identity (`firebaserules.rulesets.test`).
 * Messaging and live-project write rigs use the separate main-only
 * `CAPTURE_WIF_PROVIDER` + `CAPTURE_SA_EMAIL` identity so write roles are never
 * granted to the PR-reachable parity identity. Paid generative model rigs omit
 * `autoPushSafe` so they stay manual-dispatch only.
 */
const RIG_CAPTURE_POLICIES: Readonly<Record<string, RigCapturePolicy>> = {
  'admin-app': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'admin-auth': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission: 'firebaseauth.users.create, firebaseauth.users.get, firebaseauth.users.delete',
      role: 'roles/firebaseauth.admin',
      api: 'identitytoolkit.googleapis.com',
    },
  },
  'admin-firestore': {
    filterFlag: '--probe',
    perProbeStaged: true,
    iamHint: {
      permission: 'datastore.entities.create, datastore.entities.get, datastore.entities.delete',
      role: 'roles/datastore.user',
      api: 'firestore.googleapis.com',
    },
  },
  'android-sdk-probes': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission:
        'firebase.projects.get, firebase.clients.list, firebaseauth.users.create, firebasedatabase.instances.update',
      role: 'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin',
      api: 'firebase.googleapis.com, identitytoolkit.googleapis.com, firebasedatabase.googleapis.com',
    },
  },
  'app-registry': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'client-storage': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
  },
  'firestore-rules-sibling-merge': {
    iamHint: LIVE_SDK_IAM_HINT,
  },
  'ios-sdk-probes': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission:
        'firebase.projects.get, firebase.clients.list, firebaseauth.users.create, firebasedatabase.instances.update',
      role: 'roles/firebase.viewer, roles/firebaseauth.admin, roles/firebasedatabase.admin',
      api: 'firebase.googleapis.com, identitytoolkit.googleapis.com, firebasedatabase.googleapis.com',
    },
  },
  'messaging-send': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: {
      permission: 'cloudmessaging.messages.create',
      role: 'roles/firebasecloudmessaging.admin',
      api: 'fcm.googleapis.com',
    },
  },
  'oracle-run': {
    iamHint: LIVE_SDK_IAM_HINT,
  },
  'rules-firestore': {
    readonlyParityWif: true,
    filterFlag: '--scenario',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
  'rules-storage': {
    readonlyParityWif: true,
    filterFlag: '--scenario',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
  'sdk-probes': {
    filterFlag: '--probe',
    autoPushSafe: true,
    perProbeStaged: true,
    iamHint: LIVE_SDK_IAM_HINT,
  },
  'storage-admin': {
    filterFlag: '--probe',
    perProbeStaged: true,
    iamHint: {
      permission: 'storage.objects.create, storage.objects.get, storage.objects.delete',
      role: 'roles/storage.objectAdmin',
      api: 'storage.googleapis.com',
    },
  },
  'storage-stdlib-discovery': {
    readonlyParityWif: true,
    filterFlag: '--probe',
    autoPushSafe: true,
    iamHint: RULES_VIEWER_IAM_HINT,
  },
};

export function policyForRig(rigId: string): RigCapturePolicy {
  const configured = RIG_CAPTURE_POLICIES[rigId];
  if (configured !== undefined) {
    return configured;
  }
  return EMPTY_POLICY;
}

export function hintForExtractedPermission(permission: string): RigIamHint | undefined {
  if (permission.startsWith('cloudmessaging.')) {
    return policyForRig('messaging-send').iamHint;
  }
  if (permission.startsWith('firebaseauth.')) {
    return policyForRig('admin-auth').iamHint;
  }
  if (permission.startsWith('firebasedatabase.')) {
    return {
      permission,
      role: 'roles/firebasedatabase.admin',
      api: 'firebasedatabase.googleapis.com',
    };
  }
  if (permission.startsWith('datastore.')) {
    return policyForRig('admin-firestore').iamHint;
  }
  if (permission.startsWith('storage.')) {
    return policyForRig('storage-admin').iamHint;
  }
  if (permission === 'firebaserules.rulesets.test') {
    return RULES_VIEWER_IAM_HINT;
  }
  if (permission.startsWith('firebaserules.')) {
    return {
      permission,
      role: 'roles/firebaserules.admin',
      api: 'firebaserules.googleapis.com',
    };
  }
  if (permission.startsWith('firebase.')) {
    return {
      permission,
      role: 'roles/firebase.viewer',
      api: 'firebase.googleapis.com',
    };
  }
  return undefined;
}
