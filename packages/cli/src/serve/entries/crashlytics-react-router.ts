'use client';
/** The canonical `firebase/crashlytics/react-router` served mirror. */
import type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
  CrashlyticsReactElement,
  CrashlyticsRouteLocation,
  ReactRouterCrashlyticsRoutesProps,
} from 'pyric/crashlytics/react-router';
import { getCrashlytics, log, recordError } from './crashlytics.js';
import {
  currentServedPathname,
  emitServedViewBoundary,
  matchServedReactRouterChildren,
} from './crashlytics-framework-runtime.js';

export type {
  AttributePrimitive,
  Attributes,
  AttributeValue,
  Crashlytics,
  CrashlyticsAttributes,
  CrashlyticsFeature,
  CrashlyticsOptions,
  CrashlyticsReactElement,
  CrashlyticsRouteLocation,
  ReactRouterCrashlyticsRoutesProps,
};

interface BoundaryProps {
  onError: (error: unknown) => void;
  children: unknown;
}

interface BoundaryState {
  error: unknown;
}

interface ReactUpdaterLike {
  enqueueSetState?: (
    publicInstance: unknown,
    partialState: Partial<BoundaryState>,
    callback: (() => void) | undefined,
    callerName: string,
  ) => void;
}

class ServedCrashlyticsErrorBoundary {
  readonly props: BoundaryProps;
  state: BoundaryState;
  refs: Record<string, unknown> = {};
  updater?: ReactUpdaterLike;

  constructor(props: BoundaryProps, _context?: unknown, updater?: ReactUpdaterLike) {
    this.props = props;
    this.state = { error: null };
    this.updater = updater;
  }

  setState(partialState: Partial<BoundaryState>, callback?: () => void): void {
    this.updater?.enqueueSetState?.(this, partialState, callback, 'setState');
  }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
    throw error;
  }

  render(): unknown {
    if (this.state.error !== null) {
      return null;
    }
    return this.props.children;
  }
}

(ServedCrashlyticsErrorBoundary.prototype as unknown as { isReactComponent: Record<string, never> }).isReactComponent = {};

function resolvePathname(
  locationProp: Partial<CrashlyticsRouteLocation> | string | undefined,
): string {
  if (typeof locationProp === 'string' && locationProp.length > 0) {
    return locationProp;
  }
  if (
    typeof locationProp === 'object' &&
    locationProp !== null &&
    typeof locationProp.pathname === 'string' &&
    locationProp.pathname.length > 0
  ) {
    return locationProp.pathname;
  }
  return currentServedPathname();
}

export function CrashlyticsRoutes({
  firebaseApp,
  crashlyticsOptions,
  children,
  location,
}: ReactRouterCrashlyticsRoutesProps): CrashlyticsReactElement | null {
  const crashlytics = getCrashlytics(firebaseApp, crashlyticsOptions);
  const pathname = resolvePathname(location);
  const matched = matchServedReactRouterChildren(children, pathname);

  emitServedViewBoundary(log, crashlytics, firebaseApp, matched.pattern, crashlyticsOptions);

  if (matched.rendered === null || matched.rendered === undefined) {
    return null;
  }

  if (matched.elementSymbol !== undefined) {
    const boundaryElement = {
      $$typeof: matched.elementSymbol,
      type: ServedCrashlyticsErrorBoundary,
      key: pathname,
      ref: null,
      props: {
        onError: (error: unknown) => {
          recordError(crashlytics, error);
        },
        children: matched.rendered,
      },
      _owner: null,
      _store: {},
    };
    return boundaryElement as unknown as CrashlyticsReactElement;
  }

  return matched.rendered as CrashlyticsReactElement;
}
