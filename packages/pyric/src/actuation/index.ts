/**
 * `pyric/actuation` — Pure, composable domain services for sandbox actuation
 * across Data/Query, Storage, Auth, Experimentation/Diagnostics, and Environment.
 */

export {
  mutateSandboxData,
  querySandboxData,
  resolveAuthContext,
  type AuthOverrideInput,
  type BatchOperationInput,
  type MutateSandboxDataInput,
  type MutateSandboxDataOutput,
  type QueryFilterInput,
  type QuerySandboxDataInput,
  type QuerySandboxDataOutput,
} from './data-service.js';

export {
  manageStorageFiles,
  type ManageStorageFilesInput,
  type ManageStorageFilesOutput,
} from './storage-service.js';

export {
  manageAuthUsers,
  inspectAuthFlow,
  switchAuthIdentity,
  getActiveIdentityLens,
  resetActiveIdentityLens,
  type ActiveIdentityLens,
  type SwitchAuthIdentityInput,
  type SwitchAuthIdentityOutput,
  type ManageAuthUsersInput,
  type ManageAuthUsersOutput,
  type InspectAuthFlowInput,
  type InspectAuthFlowOutput,
} from './auth-service.js';

export {
  dryRunExperiment,
  diagnoseRuleDenial,
  verifySecurityRules,
  type RuleRegression,
  type DryRunExperimentInput,
  type DryRunExperimentOutput,
  type DiagnoseRuleDenialInput,
  type DiagnoseRuleDenialOutput,
  type VerifySecurityRulesInput,
  type VerifySecurityRulesOutput,
} from './experiment-service.js';

export {
  controlSandboxEnvironment,
  invokeCloudFunction,
  configureAiMock,
  readSandboxResource,
  getSandboxCurrentTimeIso,
  getSandboxNetworkState,
  type SandboxClockState,
  type ControlSandboxEnvironmentInput,
  type ControlSandboxEnvironmentOutput,
  type InvokeCloudFunctionInput,
  type InvokeCloudFunctionOutput,
  type ConfigureAiMockInput,
  type ConfigureAiMockOutput,
} from './environment-service.js';
