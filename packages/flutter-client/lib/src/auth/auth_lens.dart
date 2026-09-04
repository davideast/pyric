import 'package:collection/collection.dart';

/// Defines the authentication context attached to Firestore operations.
sealed class AuthLens {
  const AuthLens();

  Map<String, dynamic> toMap();

  String get mode {
    switch (this) {
      case AdminLens():
        return 'admin';
      case AnonLens():
        return 'anon';
      case AppSessionLens():
        return 'app-session';
      case AsUserLens():
        return 'as';
    }
  }

  String? get uid => this is AsUserLens ? (this as AsUserLens).uid : null;
  String? get tenant => this is AsUserLens ? (this as AsUserLens).tenant : null;
  Map<String, dynamic>? get token =>
      this is AsUserLens ? (this as AsUserLens).token : null;

  static const AuthLens anon = AnonLens();
  static const AuthLens admin = AdminLens();
  static const AuthLens appSession = AppSessionLens();

  static AuthLens asUser({
    required String uid,
    String? tenant,
    Map<String, dynamic>? token,
  }) =>
      AsUserLens(uid: uid, tenant: tenant, token: token);
}

/// Unauthenticated lens — forces Security Rules to evaluate with `request.auth == null`.
class AnonLens extends AuthLens {
  const AnonLens();

  @override
  Map<String, dynamic> toMap() => const {'mode': 'anon'};

  @override
  bool operator ==(Object other) => other is AnonLens;

  @override
  int get hashCode => 0;

  @override
  String toString() => 'AuthLens.anon';
}

/// Admin bypass lens — bypasses Security Rules checks entirely.
class AdminLens extends AuthLens {
  const AdminLens();

  @override
  Map<String, dynamic> toMap() => const {'mode': 'admin'};

  @override
  bool operator ==(Object other) => other is AdminLens;

  @override
  int get hashCode => 1;

  @override
  String toString() => 'AuthLens.admin';
}

/// Browser session lens — inherits the browser tab's interactive identity.
class AppSessionLens extends AuthLens {
  const AppSessionLens();

  @override
  Map<String, dynamic> toMap() => const {'mode': 'app-session'};

  @override
  bool operator ==(Object other) => other is AppSessionLens;

  @override
  int get hashCode => 2;

  @override
  String toString() => 'AuthLens.appSession';
}

/// Authenticated user impersonation lens — evaluates Security Rules as the given identity.
class AsUserLens extends AuthLens {
  @override
  final String uid;
  @override
  final String? tenant;
  @override
  final Map<String, dynamic>? token;

  const AsUserLens({required this.uid, this.tenant, this.token});

  @override
  Map<String, dynamic> toMap() => {
        'mode': 'as',
        'uid': uid,
        if (tenant != null) 'tenant': tenant,
        if (token != null) 'token': token,
      };

  @override
  bool operator ==(Object other) =>
      other is AsUserLens &&
      other.uid == uid &&
      other.tenant == tenant &&
      const DeepCollectionEquality().equals(other.token, token);

  @override
  int get hashCode => Object.hash(
        uid,
        tenant,
        const DeepCollectionEquality().hash(token),
      );

  @override
  String toString() => 'AuthLens.asUser(uid: $uid, tenant: $tenant, token: $token)';
}
