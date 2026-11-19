import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["initializeServerApp"],
  section: "Deferred",
  api: "initializeServerApp",
  behavior: "Not implemented; disposition `app.server-app` owns the reviewed availability and rationale",
  status: "unsupported",
  evidence: "disposition:app.server-app",
  automation: "unsupported",
  exceptionReason: "availability policy is authored in disposition `app.server-app`",
});
