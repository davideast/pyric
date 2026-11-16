final RegExp _bareInstanceName = RegExp(r'^[A-Za-z0-9][A-Za-z0-9-]*$');
final RegExp _ipv4Host = RegExp(r'^\d+\.\d+\.\d+\.\d+$');

/// Resolves the Pyric wire `instance` name from a Realtime Database
/// [databaseURL] (or bare instance name).
///
/// Returns `null` when targeting the default instance (absent/empty URL,
/// `default` sentinel, or a URL naming the app's default `<projectId>` or
/// `<projectId>-default-rtdb` instance).
String? resolveDatabaseInstanceName(
  String? databaseURL, {
  String? projectId,
}) {
  if (databaseURL == null) return null;
  final trimmed = databaseURL.trim();
  if (trimmed.isEmpty) return null;

  String? rawName;
  if (_bareInstanceName.hasMatch(trimmed)) {
    rawName = trimmed.toLowerCase();
  } else {
    final normalized = trimmed.contains('://') ? trimmed : 'https://$trimmed';
    final uri = Uri.tryParse(normalized);
    if (uri == null) return null;

    final ns = uri.queryParameters['ns'];
    if (ns != null && ns.trim().isNotEmpty) {
      rawName = ns.trim().toLowerCase();
    } else {
      final host = uri.host.toLowerCase();
      if (host.isEmpty || host == 'localhost' || _ipv4Host.hasMatch(host)) {
        return null;
      }
      final labels = host.split('.');
      if (labels.length > 2 && labels.first.isNotEmpty) {
        rawName = labels.first;
      }
    }
  }

  if (rawName == null || rawName.isEmpty || rawName == 'default') {
    return null;
  }
  if (!_bareInstanceName.hasMatch(rawName)) {
    return null;
  }

  final cleanProjectId = projectId?.trim().toLowerCase();
  if (cleanProjectId != null && cleanProjectId.isNotEmpty) {
    final isProjectDefault =
        rawName == cleanProjectId || rawName == '$cleanProjectId-default-rtdb';
    if (isProjectDefault) return null;
  }

  return rawName;
}
