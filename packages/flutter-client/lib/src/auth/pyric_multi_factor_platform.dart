import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

/// Concrete [MultiFactorPlatform] fulfilling the multi-factor contract for Pyric.
class PyricMultiFactorPlatform extends MultiFactorPlatform {
  PyricMultiFactorPlatform(super.auth);
}
