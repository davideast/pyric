/**
 * Zero-dependency route formatting, route-tree matching, and view-boundary
 * helpers shared across the Crashlytics framework subpath mirrors.
 */
import type { FirebaseApp } from '../app/types.js';
import type { Attributes, Crashlytics, CrashlyticsOptions } from './types.js';

const APP_SCREEN_ID_ATTR = 'app.screen.id';
const VIEW_BOUNDARY_MESSAGE = 'Navigation event';

/** Minimal Crashlytics operations used by the framework subpath mirrors. */
export interface CrashlyticsFrameworkDriver {
  getCrashlytics(app?: FirebaseApp, options?: CrashlyticsOptions): Crashlytics;
  log(crashlytics: Crashlytics, message: string, attributes?: Attributes): void;
  recordError(crashlytics: Crashlytics, error: unknown, attributes?: Attributes): void;
}

const breadcrumbsEnabledApps = new WeakSet<FirebaseApp>();
const lastLoggedPatternByApp = new WeakMap<FirebaseApp, string>();

function isBreadcrumbsPlugin(feature: unknown): boolean {
  if (typeof feature !== 'object' || feature === null) {
    return false;
  }
  const named = feature as { name?: unknown };
  if (named.name === 'breadcrumbs') {
    return true;
  }
  const symbols = Object.getOwnPropertySymbols(feature);
  for (const sym of symbols) {
    if (sym.description === 'pyric.crashlytics.breadcrumbs') {
      return true;
    }
  }
  return false;
}

/** Records whether `breadcrumbs()` was enabled for `app` and returns the active status. */
export function rememberBreadcrumbsOption(
  app: FirebaseApp,
  options?: CrashlyticsOptions,
): boolean {
  if (Array.isArray(options?.features) && options.features.some(isBreadcrumbsPlugin)) {
    breadcrumbsEnabledApps.add(app);
  }
  return breadcrumbsEnabledApps.has(app);
}

/**
 * Emits a Crashlytics view-boundary breadcrumb log when `breadcrumbs()` is
 * enabled on `app` and the route pattern changed (or `forceLog` is set).
 */
export function emitViewBoundaryIfChanged(
  driver: CrashlyticsFrameworkDriver,
  crashlytics: Crashlytics,
  app: FirebaseApp,
  pattern: string,
  options?: CrashlyticsOptions,
  forceLog = false,
): void {
  const enabled = rememberBreadcrumbsOption(app, options);
  const previous = lastLoggedPatternByApp.get(app);
  if (!forceLog && previous === pattern) {
    return;
  }
  lastLoggedPatternByApp.set(app, pattern);
  if (!enabled) {
    return;
  }
  driver.log(crashlytics, VIEW_BOUNDARY_MESSAGE, {
    [APP_SCREEN_ID_ATTR]: pattern,
  });
}

/** Reads `window.location.pathname` when running in a browser, defaulting to `'/'`. */
export function currentBrowserPathname(): string {
  const win = (globalThis as { window?: { location?: { pathname?: unknown } } }).window;
  const raw = win?.location?.pathname;
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return '/';
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Constructs a parameterized route template for Next.js App Router by replacing
 * dynamic parameter values in `pathname` with `:param` / `:param*` placeholders.
 */
export function formatParameterizedRoute(
  pathname: string | null | undefined,
  params?: Record<string, string | string[] | undefined> | null,
): string {
  if (!pathname) {
    return '/';
  }
  if (!params || Object.keys(params).length === 0) {
    return pathname;
  }
  let routePattern = pathname;
  for (const [key, value] of Object.entries(params)) {
    if (!value) {
      continue;
    }
    if (typeof value === 'string') {
      const escapedVal = escapeRegexLiteral(value);
      routePattern = routePattern.replace(
        new RegExp(`/${escapedVal}(?=/|$)`),
        `/:${key}`,
      );
    } else if (Array.isArray(value) && value.length > 0) {
      const stringParts = value.filter((item): item is string => typeof item === 'string');
      if (stringParts.length > 0) {
        const escapedPath = stringParts.map(escapeRegexLiteral).join('/');
        routePattern = routePattern.replace(
          new RegExp(`/${escapedPath}(?=/|$)`),
          `/:${key}*`,
        );
      }
    }
  }
  return routePattern;
}

/**
 * Strips query parameters, hash fragments, and Angular matrix parameters
 * (`;key=value`) from a URL string, returning a normalized leading-slash path.
 */
export function stripUrlDecorations(url: string): string {
  let endIndex = url.length;
  const hashIndex = url.indexOf('#');
  if (hashIndex !== -1 && hashIndex < endIndex) {
    endIndex = hashIndex;
  }
  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1 && queryIndex < endIndex) {
    endIndex = queryIndex;
  }
  const rawPath = url.slice(0, endIndex);
  const rawSegments = rawPath.split('/');
  const cleanSegments: string[] = [];
  for (const segment of rawSegments) {
    const matrixIndex = segment.indexOf(';');
    const clean = matrixIndex === -1 ? segment : segment.slice(0, matrixIndex);
    if (clean.length > 0) {
      cleanSegments.push(clean);
    }
  }
  if (cleanSegments.length === 0) {
    return '/';
  }
  return `/${cleanSegments.join('/')}`;
}

interface JsxElementLike {
  readonly $$typeof?: symbol;
  readonly type: unknown;
  readonly props?: Record<string, unknown>;
}

interface ParsedRouteNode {
  readonly path?: string;
  readonly index?: boolean;
  readonly element?: unknown;
  readonly children: ParsedRouteNode[];
}

function isJsxElementLike(value: unknown): value is JsxElementLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return 'type' in record && 'props' in record;
}

function findReactElementSymbol(value: unknown): symbol | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findReactElementSymbol(entry);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isJsxElementLike(value)) {
    return undefined;
  }
  if (typeof value.$$typeof === 'symbol') {
    return value.$$typeof;
  }
  return findReactElementSymbol(value.props?.children);
}

function isRouteElement(element: JsxElementLike): boolean {
  const props = element.props;
  if (typeof props !== 'object' || props === null) {
    return false;
  }
  return 'path' in props || 'index' in props || 'element' in props;
}

const REACT_FRAGMENT_SYMBOL = Symbol.for('react.fragment');

function collectRouteNodes(children: unknown): {
  routes: ParsedRouteNode[];
  hasRouteElements: boolean;
} {
  const routes: ParsedRouteNode[] = [];
  let hasRouteElements = false;

  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isJsxElementLike(node)) {
      return;
    }
    if (node.type === REACT_FRAGMENT_SYMBOL) {
      visit(node.props?.children);
      return;
    }
    if (!isRouteElement(node)) {
      return;
    }
    hasRouteElements = true;
    const props = node.props ?? {};
    const nested = collectRouteNodes(props.children);
    let routePath: string | undefined;
    if (typeof props.path === 'string') {
      routePath = props.path;
    }
    routes.push({
      path: routePath,
      index: props.index === true,
      element: props.element,
      children: nested.routes,
    });
  };

  visit(children);
  return { routes, hasRouteElements };
}

function splitPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

interface RouteMatchOutcome {
  readonly matchedPatterns: string[];
  readonly element: unknown;
}

function matchRouteSegmentList(
  routeSegments: readonly string[],
  urlSegments: readonly string[],
  startIndex: number,
  allowPrefix: boolean,
): number | null {
  let urlIndex = startIndex;
  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSeg = routeSegments[i];
    if (routeSeg === '*') {
      return urlSegments.length;
    }
    if (urlIndex >= urlSegments.length) {
      return null;
    }
    const currentUrlSeg = urlSegments[urlIndex];
    if (routeSeg !== undefined && routeSeg.startsWith(':')) {
      urlIndex += 1;
      continue;
    }
    if (routeSeg !== currentUrlSeg) {
      return null;
    }
    urlIndex += 1;
  }
  if (!allowPrefix && urlIndex !== urlSegments.length) {
    return null;
  }
  return urlIndex;
}

function matchParsedRoutes(
  routes: readonly ParsedRouteNode[],
  urlSegments: readonly string[],
  startIndex: number,
): RouteMatchOutcome | null {
  for (const route of routes) {
    if (route.index === true) {
      if (startIndex === urlSegments.length) {
        return { matchedPatterns: [], element: route.element ?? null };
      }
      continue;
    }

    const rawPath = route.path ?? '';
    const routeSegments = rawPath === '/' ? [] : splitPathSegments(rawPath);
    const hasChildren = route.children.length > 0;
    const nextIndex = matchRouteSegmentList(
      routeSegments,
      urlSegments,
      startIndex,
      hasChildren,
    );
    if (nextIndex === null) {
      continue;
    }

    const ownPatterns: string[] = [];
    if (rawPath.length > 0 && rawPath !== '/') {
      const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
      if (trimmed.length > 0) {
        ownPatterns.push(trimmed);
      }
    }

    if (hasChildren) {
      const childMatch = matchParsedRoutes(route.children, urlSegments, nextIndex);
      if (childMatch !== null) {
        let leafElement = childMatch.element;
        if (leafElement === null || leafElement === undefined) {
          leafElement = route.element ?? null;
        }
        return {
          matchedPatterns: [...ownPatterns, ...childMatch.matchedPatterns],
          element: leafElement,
        };
      }
    }

    if (nextIndex === urlSegments.length) {
      return {
        matchedPatterns: ownPatterns,
        element: route.element ?? null,
      };
    }
  }
  return null;
}

/** Result of evaluating `CrashlyticsRoutes` children against a pathname. */
export interface MatchedReactRouterResult {
  readonly pattern: string;
  readonly rendered: unknown;
  readonly elementSymbol: symbol | undefined;
}

/**
 * Matches `<Route>` JSX children (when present) against `pathname` to derive
 * the parameterized Crashlytics route pattern and the rendered element.
 */
export function matchReactRouterChildren(
  children: unknown,
  pathname: string,
): MatchedReactRouterResult {
  const cleanPathname = stripUrlDecorations(pathname);
  const elementSymbol = findReactElementSymbol(children);
  const { routes, hasRouteElements } = collectRouteNodes(children);
  if (!hasRouteElements) {
    let directRendered: unknown = null;
    if (children !== undefined && children !== null && typeof children !== 'boolean') {
      directRendered = children;
    }
    return {
      pattern: cleanPathname,
      rendered: directRendered,
      elementSymbol,
    };
  }

  const urlSegments = splitPathSegments(cleanPathname);
  const match = matchParsedRoutes(routes, urlSegments, 0);
  if (match === null) {
    return {
      pattern: '/',
      rendered: null,
      elementSymbol,
    };
  }
  const joined = match.matchedPatterns.join('/');
  const pattern = joined.length > 0 ? `/${joined}` : '/';
  const matchedSymbol = findReactElementSymbol(match.element) ?? elementSymbol;
  return {
    pattern,
    rendered: match.element ?? null,
    elementSymbol: matchedSymbol,
  };
}
