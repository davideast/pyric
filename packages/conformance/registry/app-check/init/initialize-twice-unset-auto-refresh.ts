import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'oracle-backed',
  api: 'initializeAppCheck(app, options) called twice',
  featureKeys: ['initializeAppCheck'],
  behavior: 'An omitted `isTokenAutoRefreshEnabled` equals `false`: a first call that omits it followed by one that passes `false`, the reverse, or two calls that both omit it, return the same instance. Only `true` against `false` or omitted throws `appCheck/already-initialized`.',
  evidence: 'capture `app-check-client-initialize-twice-unset-auto-refresh` (`unsetThenFalse`, `falseThenUnset`, `unsetThenUnset`). Upstream `initializeAppCheck` in `@firebase/app-check` 0.13.1 (firebase 12.19.0) compares `!!initialOptions.isTokenAutoRefreshEnabled === !!options.isTokenAutoRefreshEnabled`; 0.11.3 compared the raw values.',
  observations: ['app-check-client-initialize-twice-unset-auto-refresh'],
  errorText: true,
});
