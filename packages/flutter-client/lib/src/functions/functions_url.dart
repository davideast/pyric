import 'functions_exceptions.dart';

/// Default Cloud Functions region when none is specified.
const String defaultFunctionsRegion = 'us-central1';

/// Query marker appended when rewriting regional Cloud Run URLs to the local gateway.
const String runServiceQuery = '?__pyric_run_service=1';

final RegExp _legacyRunHostPattern = RegExp(
  r'^([a-z0-9-]+)-[a-z0-9]+-([a-z]{2})\.a\.run\.app$',
  caseSensitive: false,
);

final RegExp _regionalRunHostPattern = RegExp(
  r'^([a-z0-9-]+)-\d+\.([a-z0-9-]+)\.run\.app$',
  caseSensitive: false,
);

/// Result of splitting a region-or-custom-domain argument.
class ParsedFunctionsRegionOrDomain {
  final String region;
  final String? customDomain;

  const ParsedFunctionsRegionOrDomain({
    required this.region,
    required this.customDomain,
  });
}

/// Resolved HTTP target URL for a callable invocation.
class ResolvedCallableTarget {
  final Uri uri;
  final String? ambiguousRunWarning;

  const ResolvedCallableTarget({
    required this.uri,
    this.ambiguousRunWarning,
  });
}

/// Parses a region name or custom HTTP(S) domain URL, matching Firebase Functions semantics.
ParsedFunctionsRegionOrDomain parseRegionOrCustomDomain(
  String? regionOrCustomDomain,
) {
  if (regionOrCustomDomain == null || regionOrCustomDomain.isEmpty) {
    return const ParsedFunctionsRegionOrDomain(
      region: defaultFunctionsRegion,
      customDomain: null,
    );
  }
  final parsed = Uri.tryParse(regionOrCustomDomain);
  if (parsed != null &&
      (parsed.scheme == 'http' || parsed.scheme == 'https') &&
      parsed.host.isNotEmpty) {
    final normalizedPath = _stripTrailingSlash(parsed.path);
    final custom = Uri(
      scheme: parsed.scheme,
      userInfo: parsed.userInfo,
      host: parsed.host,
      port: parsed.hasPort ? parsed.port : null,
      path: normalizedPath,
    ).toString();
    return ParsedFunctionsRegionOrDomain(
      region: defaultFunctionsRegion,
      customDomain: _stripTrailingSlash(custom),
    );
  }
  return ParsedFunctionsRegionOrDomain(
    region: regionOrCustomDomain,
    customDomain: null,
  );
}

/// Normalizes an emulator `(host, port)` pair into an `http://<host>:<port>` origin.
///
/// Translates the Android emulator loopback alias `10.0.2.2` to `127.0.0.1` so
/// pure-Dart desktop/CI tests and mobile code share one configuration surface.
String normalizeEmulatorOrigin(String host, int port) {
  final trimmed = host.trim();
  if (trimmed.isEmpty) {
    throw ArgumentError.value(host, 'host', 'Emulator host must not be empty.');
  }
  if (port <= 0 || port > 65535) {
    throw ArgumentError.value(port, 'port', 'Emulator port must be 1..65535.');
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    final uri = Uri.parse(trimmed);
    final mappedHost = uri.host == '10.0.2.2' ? '127.0.0.1' : uri.host;
    return Uri(
      scheme: uri.scheme,
      host: mappedHost,
      port: port,
    ).toString();
  }
  final unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.substring(1, trimmed.length - 1)
      : trimmed;
  final mappedHost = unbracketed == '10.0.2.2' ? '127.0.0.1' : unbracketed;
  final formattedHost = mappedHost.contains(':') ? '[$mappedHost]' : mappedHost;
  return 'http://$formattedHost:$port';
}

/// Checks whether [host] is a local loopback address (`127.0.0.1`, `localhost`, `::1`, `10.0.2.2`).
bool isLoopbackHost(String host) {
  final normalized = host.startsWith('[') && host.endsWith(']')
      ? host.substring(1, host.length - 1).toLowerCase()
      : host.toLowerCase();
  return normalized == '127.0.0.1' ||
      normalized == 'localhost' ||
      normalized == '::1' ||
      normalized == '10.0.2.2';
}

String _stripTrailingSlash(String input) {
  if (input.endsWith('/')) {
    return input.substring(0, input.length - 1);
  }
  return input;
}

String _stripLeadingSlashes(String input) {
  var index = 0;
  while (index < input.length && input.codeUnitAt(index) == 0x2F) {
    index += 1;
  }
  return input.substring(index);
}

bool _sameOrigin(Uri left, Uri right) {
  final leftPort = left.hasPort
      ? left.port
      : (left.scheme == 'https' ? 443 : 80);
  final rightPort = right.hasPort
      ? right.port
      : (right.scheme == 'https' ? 443 : 80);
  return left.scheme == right.scheme &&
      left.host.toLowerCase() == right.host.toLowerCase() &&
      leftPort == rightPort;
}

Uri _rewriteLoopbackAlias(Uri uri) {
  if (uri.host == '10.0.2.2') {
    return uri.replace(host: '127.0.0.1');
  }
  return uri;
}

/// Resolves a named callable (`httpsCallable(name)`) to a local gateway or loopback URI.
ResolvedCallableTarget resolveNamedCallableTarget({
  required String name,
  required String projectId,
  required String region,
  required String? customDomain,
  required String? emulatorOrigin,
  required String? gatewayOrigin,
}) {
  final cleanName = _stripLeadingSlashes(name.trim());
  if (cleanName.isEmpty) {
    throw ArgumentError.value(name, 'name', 'Callable function name must not be empty.');
  }

  if (emulatorOrigin != null) {
    final base = _stripTrailingSlash(emulatorOrigin);
    return ResolvedCallableTarget(
      uri: Uri.parse('$base/$projectId/$region/$cleanName'),
    );
  }

  if (customDomain != null) {
    final domainUri = Uri.parse(customDomain);
    if (gatewayOrigin != null) {
      final gwUri = Uri.parse(gatewayOrigin);
      if (_sameOrigin(domainUri, gwUri)) {
        final base = _stripTrailingSlash(customDomain);
        return ResolvedCallableTarget(uri: Uri.parse('$base/$cleanName'));
      }
    }
    if (isLoopbackHost(domainUri.host)) {
      final rewrittenDomain = _stripTrailingSlash(
        _rewriteLoopbackAlias(domainUri).toString(),
      );
      return ResolvedCallableTarget(uri: Uri.parse('$rewrittenDomain/$cleanName'));
    }
    throw FirebaseFunctionsException(
      code: 'unavailable',
      message:
          'pyric_functions: customDomain "$customDomain" points off-machine and cannot be called in sandbox mode.',
    );
  }

  if (gatewayOrigin != null) {
    final base = _stripTrailingSlash(gatewayOrigin);
    return ResolvedCallableTarget(
      uri: Uri.parse('$base/$projectId/$region/$cleanName'),
    );
  }

  throw FirebaseFunctionsException(
    code: 'unavailable',
    message:
        'pyric_functions: no local Functions emulator or Pyric gateway origin is configured for "$cleanName".',
  );
}

/// Resolves a URL callable (`httpsCallableFromUrl` / `httpsCallableFromUri`) to a local target,
/// rewriting Cloud Functions and Cloud Run URLs onto the local gateway and refusing off-machine origins.
ResolvedCallableTarget resolveUrlCallableTarget({
  required String rawUrl,
  required String projectId,
  required String? emulatorOrigin,
  required String? gatewayOrigin,
}) {
  final parsed = Uri.tryParse(rawUrl);
  if (parsed == null ||
      (parsed.scheme != 'http' && parsed.scheme != 'https') ||
      parsed.host.isEmpty) {
    throw FirebaseFunctionsException(
      code: 'invalid-argument',
      message: 'Invalid callable URL: $rawUrl',
    );
  }

  final activeGateway = emulatorOrigin ?? gatewayOrigin;
  final hostLower = parsed.host.toLowerCase();

  if (hostLower.endsWith('.cloudfunctions.net')) {
    if (activeGateway == null) {
      throw FirebaseFunctionsException(
        code: 'unavailable',
        message:
            'pyric_functions: refusing to call off-machine Cloud Functions URL "$rawUrl" without a local gateway.',
      );
    }
    final prefix = hostLower.substring(
      0,
      hostLower.length - '.cloudfunctions.net'.length,
    );
    final fnName = parsed.pathSegments.where((s) => s.isNotEmpty).firstOrNull;
    final projSuffix = '-${projectId.toLowerCase()}';
    if (fnName != null && prefix.endsWith(projSuffix)) {
      final region = prefix.substring(0, prefix.length - projSuffix.length);
      if (region.isNotEmpty) {
        final base = _stripTrailingSlash(activeGateway);
        return ResolvedCallableTarget(
          uri: Uri.parse('$base/$projectId/$region/$fnName'),
        );
      }
    }
    throw FirebaseFunctionsException(
      code: 'unavailable',
      message:
          'pyric_functions: Cloud Functions URL "$rawUrl" does not match local project "$projectId".',
    );
  }

  final legacyMatch = _legacyRunHostPattern.firstMatch(hostLower);
  if (legacyMatch != null) {
    if (activeGateway == null) {
      throw FirebaseFunctionsException(
        code: 'unavailable',
        message:
            'pyric_functions: refusing to call off-machine Cloud Run URL "$rawUrl" without a local gateway.',
      );
    }
    final service = legacyMatch.group(1)!;
    final base = _stripTrailingSlash(activeGateway);
    return ResolvedCallableTarget(
      uri: Uri.parse('$base/$projectId/-/$service$runServiceQuery'),
      ambiguousRunWarning:
          'pyric_functions: Cloud Run URL "$rawUrl" omits region in hostname; routing "$service" across discovered regions.',
    );
  }

  final regionalMatch = _regionalRunHostPattern.firstMatch(hostLower);
  if (regionalMatch != null) {
    if (activeGateway == null) {
      throw FirebaseFunctionsException(
        code: 'unavailable',
        message:
            'pyric_functions: refusing to call off-machine Cloud Run URL "$rawUrl" without a local gateway.',
      );
    }
    final service = regionalMatch.group(1)!;
    final region = regionalMatch.group(2)!;
    final base = _stripTrailingSlash(activeGateway);
    return ResolvedCallableTarget(
      uri: Uri.parse('$base/$projectId/$region/$service$runServiceQuery'),
    );
  }

  if (activeGateway != null && _sameOrigin(parsed, Uri.parse(activeGateway))) {
    return ResolvedCallableTarget(uri: _rewriteLoopbackAlias(parsed));
  }

  if (isLoopbackHost(parsed.host)) {
    return ResolvedCallableTarget(uri: _rewriteLoopbackAlias(parsed));
  }

  throw FirebaseFunctionsException(
    code: 'unavailable',
    message:
        'pyric_functions: refusing to send callable traffic to off-machine origin "${parsed.origin}".',
  );
}
