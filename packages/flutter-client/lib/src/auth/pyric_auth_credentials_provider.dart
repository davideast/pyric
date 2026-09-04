import 'dart:async';

import 'auth_lens.dart';

/// Provider interface through which Firestore obtains the active authentication lens.
abstract interface class PyricAuthCredentialsProvider {
  /// The active [AuthLens] to attach to outbound Firestore operations.
  AuthLens get currentAuthLens;

  /// Stream emitting whenever the active [AuthLens] transitions.
  Stream<AuthLens> get authLensChanges;
}
