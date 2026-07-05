export * from './hooks/index.js';

// Injectable auth API bundle (Pyric Studio data-backend swap): defaults to
// in-process `pyric/auth`; a consumer can provide the SharedWorker client.
export { AuthApiProvider, useAuthApi, type AuthApi } from './authApi.js';
export {
  AuthSignInHelper,
  type AuthSignInHelperProps,
} from './components/AuthSignInHelper.js';
export {
  AuthUserList,
  type AuthUserListProps,
} from './components/AuthUserList.js';
export {
  AuthUserForm,
  type AuthUserFormField,
  type AuthUserFormFieldName,
  type AuthUserFormProps,
  type AuthUserFormSubmit,
} from './components/AuthUserForm.js';
export {
  ClaimsField,
  type ClaimsFieldProps,
} from './components/ClaimsField.js';
export {
  DeleteUserWithConfirm,
  type DeleteUserWithConfirmProps,
  ClearUsersWithConfirm,
  type ClearUsersWithConfirmProps,
} from './components/confirmActions.js';
export {
  validateSerializedClaims,
  FORBIDDEN_CUSTOM_CLAIMS,
  CUSTOM_CLAIMS_MAX_LENGTH,
  type ClaimsValidationResult,
} from './claims.js';
export { PROVIDER_LABELS, providerLabel } from './providers.js';
