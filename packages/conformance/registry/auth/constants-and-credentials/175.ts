import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["fetchSignInMethodsForEmail"],
  api: "fetchSignInMethodsForEmail(auth, email)",
  behavior: "Not implemented; disposition `auth.email-enumeration` owns the reviewed availability and rationale.",
  status: "unsupported",
  evidence: "disposition:auth.email-enumeration; the `auth-fetchsigninmethodsforemail-deprecated` capture, in the #1676 re-capture (firebase 12.19.0, digame-mas, Email Enumeration Protection on), returned an empty list both for an account that has a password method and for an unknown address, so the method cannot tell them apart.",
  automation: "unsupported",
  oracleObservations: ["auth-fetchsigninmethodsforemail-deprecated"],
  exceptionReason: "availability policy is authored in disposition `auth.email-enumeration`",
});
