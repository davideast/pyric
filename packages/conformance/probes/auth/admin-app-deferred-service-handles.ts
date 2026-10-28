import admin from 'firebase-admin';
import { initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getDataConnect } from 'firebase-admin/data-connect';
import { getEventarc } from 'firebase-admin/eventarc';
import { getExtensions } from 'firebase-admin/extensions';
import { getFunctions } from 'firebase-admin/functions';
import { getInstallations } from 'firebase-admin/installations';
import { getInstanceId } from 'firebase-admin/instance-id';
import { getMachineLearning } from 'firebase-admin/machine-learning';
import { getPhoneNumberVerification } from 'firebase-admin/phone-number-verification';
import { getProjectManagement } from 'firebase-admin/project-management';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { captureThrow } from '../../src/captured-throw.ts';
import type { Probe } from '../../rigs/types.ts';

const CONNECTOR = { location: 'us-central1', serviceId: 'svc', connector: 'conn-a' } as const;

const FACTORIES: ReadonlyArray<readonly [string, (app?: App) => { readonly app: App }]> = [
  ['getAppCheck', (app) => getAppCheck(app)],
  ['getDataConnect', (app) => getDataConnect(CONNECTOR, app)],
  ['getEventarc', (app) => getEventarc(app)],
  ['getExtensions', (app) => getExtensions(app)],
  ['getFunctions', (app) => getFunctions(app)],
  ['getInstallations', (app) => getInstallations(app)],
  ['getInstanceId', (app) => getInstanceId(app)],
  ['getMachineLearning', (app) => getMachineLearning(app)],
  ['getPhoneNumberVerification', (app) => getPhoneNumberVerification(app)],
  ['getProjectManagement', (app) => getProjectManagement(app)],
  ['getRemoteConfig', (app) => getRemoteConfig(app)],
  ['getSecurityRules', (app) => getSecurityRules(app)],
];

const ROOT_ACCESSORS: ReadonlyArray<
  readonly [string, (app?: App) => unknown, (app?: App) => unknown]
> = [
  ['appCheck', (app) => admin.appCheck(app), (app) => getAppCheck(app)],
  ['installations', (app) => admin.installations(app), (app) => getInstallations(app)],
  ['instanceId', (app) => admin.instanceId(app), (app) => getInstanceId(app)],
  ['machineLearning', (app) => admin.machineLearning(app), (app) => getMachineLearning(app)],
  ['projectManagement', (app) => admin.projectManagement(app), (app) => getProjectManagement(app)],
  ['remoteConfig', (app) => admin.remoteConfig(app), (app) => getRemoteConfig(app)],
  ['securityRules', (app) => admin.securityRules(app), (app) => getSecurityRules(app)],
];

export const probe: Probe = {
  description:
    'All 12 additional firebase-admin modular service factories (getAppCheck, getDataConnect, getEventarc, getExtensions, getFunctions, getInstallations, getInstanceId, getMachineLearning, getPhoneNumberVerification, getProjectManagement, getRemoteConfig, getSecurityRules) and the 7 matching root admin.*() accessors throw FirebaseAppError app/no-app before initializeApp(), and after initializeApp() resolve the default or named App synchronously without network I/O, bind handle.app === app, and cache per app (with DataConnect cached per location-serviceId). rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const noAppCaptures = FACTORIES.map(([name, fn]) => ({ name, result: captureThrow(() => fn()) }));
    const baseline = noAppCaptures[0]!.result;
    const noAppAppliesTo = noAppCaptures
      .filter(({ result }) => result.threw && result.code === baseline.code && result.message === baseline.message)
      .map(({ name }) => name);

    const defaultApp = initializeApp();
    const secondaryApp = initializeApp(undefined, 'secondary');

    const resolvedFactories: string[] = [];
    let allBindExactApp = true;
    let allCachePerApp = true;
    let allIsolateNamedApp = true;

    for (const [name, fn] of FACTORIES) {
      const noArgHandle = fn();
      const explicitHandle = fn(defaultApp);
      const secondaryHandle = fn(secondaryApp);
      resolvedFactories.push(name);
      if (noArgHandle.app !== defaultApp || secondaryHandle.app !== secondaryApp) {
        allBindExactApp = false;
      }
      if (noArgHandle !== explicitHandle) {
        allCachePerApp = false;
      }
      if (secondaryHandle === explicitHandle) {
        allIsolateNamedApp = false;
      }
    }

    const matchingRootAccessors = ROOT_ACCESSORS.filter(
      ([, rootFn, modFn]) => rootFn() === modFn() && rootFn(defaultApp) === modFn(defaultApp),
    ).map(([name]) => name);

    const dcSameService =
      getDataConnect({ location: 'us-central1', serviceId: 'svc', connector: 'conn-a' }, defaultApp) ===
      getDataConnect({ location: 'us-central1', serviceId: 'svc', connector: 'conn-b' }, defaultApp);
    const dcDifferentService =
      getDataConnect({ location: 'us-central1', serviceId: 'svc-other', connector: 'conn-a' }, defaultApp) !==
      getDataConnect({ location: 'us-central1', serviceId: 'svc', connector: 'conn-a' }, defaultApp);

    return {
      noAppCode: baseline.code,
      noAppErrorName: baseline.errorName,
      noAppMessage: baseline.message,
      noAppAppliesTo,
      resolvedFactories,
      allBindExactApp,
      allCachePerApp,
      allIsolateNamedApp,
      matchingRootAccessors,
      dataConnectCachesByLocationAndServiceId: dcSameService && dcDifferentService,
    };
  },
};
