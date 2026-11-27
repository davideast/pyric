import 'package:collection/collection.dart';

String? _asString(dynamic v) => v == null ? null : (v is String ? v : v.toString());

Map<String, dynamic>? _asStringMap(dynamic v) {
  if (v is! Map) return null;
  final result = <String, dynamic>{};
  for (final entry in v.entries) {
    if (entry.key != null) {
      result[entry.key.toString()] = entry.value;
    }
  }
  return result;
}

/// Represents a sandbox user record returned from the `auth.listUsers` RPC.
class SandboxUserRecord {
  final String uid;
  final String? email;
  final String? displayName;
  final String? photoURL;
  final String? tenantId;
  final bool emailVerified;
  final Map<String, dynamic> customClaims;

  const SandboxUserRecord({
    required this.uid,
    this.email,
    this.displayName,
    this.photoURL,
    this.tenantId,
    this.emailVerified = false,
    this.customClaims = const {},
  });

  /// Parses a sandbox user record from bridge JSON wire format.
  factory SandboxUserRecord.fromMap(Map<dynamic, dynamic> map) {
    final uid = _asString(map['uid']) ?? '';
    final email = _asString(map['email']);
    final displayName = _asString(map['displayName']);
    final photoURL = _asString(map['photoURL']);
    final tenantId = _asString(map['tenantId']) ?? _asString(map['tenant']);
    final emailVerified =
        (map['emailVerified'] ?? map['email_verified']) == true;
    final claims = _asStringMap(map['customClaims']) ??
        _asStringMap(map['claims']) ??
        <String, dynamic>{};

    return SandboxUserRecord(
      uid: uid,
      email: email,
      displayName: displayName,
      photoURL: photoURL,
      tenantId: tenantId,
      emailVerified: emailVerified,
      customClaims: claims,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is SandboxUserRecord &&
        other.uid == uid &&
        other.email == email &&
        other.displayName == displayName &&
        other.photoURL == photoURL &&
        other.tenantId == tenantId &&
        other.emailVerified == emailVerified &&
        const MapEquality().equals(other.customClaims, customClaims);
  }

  @override
  int get hashCode => Object.hash(
        uid,
        email,
        displayName,
        photoURL,
        tenantId,
        emailVerified,
        const MapEquality().hash(customClaims),
      );
}
