import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';

/// Concrete [UserCredentialPlatform] returning authentication results.
class PyricUserCredentialPlatform extends UserCredentialPlatform {
  PyricUserCredentialPlatform({
    required super.auth,
    super.additionalUserInfo,
    super.credential,
    super.user,
  });
}
