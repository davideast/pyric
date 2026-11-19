import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["signInWithRedirect","getRedirectResult"],
  behavior: "`sandbox.setAuthFlowResolver(auth, resolver | null)` installs / clears the popup/redirect resolver (the analog of browser `getAuth` wiring `browserPopupRedirectResolver`)",
  rowNumber: 49,
});
