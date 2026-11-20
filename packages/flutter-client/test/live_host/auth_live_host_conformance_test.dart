import 'dart:async' show Completer;
import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart' as rtdb;
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:pyric_firestore/src/auth/auth_wire_codec.dart';

import 'auth_live_host_helper.dart';

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDown(() {
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter Auth live-host conformance (Sections 1-5)', () {
    test(
      'auth wire codec normalizes error prefixes, extracts custom claims, and maps persistence modes',
      () {
        expect(normalizeAuthErrorCode('auth/invalid-email'), equals('invalid-email'));
        expect(normalizeAuthErrorCode('wrong-password'), equals('wrong-password'));
        expect(isAccountInvalidatingAuthCode('user-disabled'), isTrue);
        expect(isAccountInvalidatingAuthCode('user-token-expired'), isTrue);
        expect(isAccountInvalidatingAuthCode('user-not-found'), isTrue);
        expect(isAccountInvalidatingAuthCode('invalid-email'), isFalse);

        final extracted = extractCustomClaimsFromJwtClaims(<String, Object?>{
          'iss': 'https://securetoken.google.com/demo',
          'sub': 'u1',
          'firebase': <String, Object?>{'sign_in_provider': 'password'},
          'role': 'ops',
          'tier': 'enterprise',
        });
        expect(extracted, equals(<String, dynamic>{'role': 'ops', 'tier': 'enterprise'}));
        expect(
          extractCustomClaimsFromJwtClaims(<String, Object?>{'sub': 'u1', 'aud': 'demo'}),
          isNull,
        );
        expect(wirePersistenceMode(Persistence.INDEXED_DB), equals('LOCAL'));
        expect(wirePersistenceMode(Persistence.SESSION), equals('SESSION'));
        expect(wirePersistenceMode(Persistence.NONE), equals('NONE'));
      },
    );

    test(
      'auth-flutter#1..10,#49..51: instance lifecycle, email/password, anonymous, signOut, Google/OAuth credentials, and custom tokens work on live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final client = session.client;
          final firestore = session.firestore;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          // #1..5: instance, instanceFor, delegateFor, registerWith, dispose
          PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
          expect(FirebaseAuthPlatform.instance, isA<PyricFirebaseAuthPlatform>());

          final secondaryApp = await Firebase.initializeApp(
            name: 'secondary-auth-$suffix',
            options: liveAuthOptions,
          );
          final viaInstanceFor = FirebaseAuthPlatform.instanceFor(
            app: secondaryApp,
            pluginConstants: const <dynamic, dynamic>{},
          );
          expect(viaInstanceFor, isA<FirebaseAuthPlatform>());

          final delegated = auth.delegateFor(app: secondaryApp);
          expect(delegated, isA<PyricFirebaseAuthPlatform>());
          await delegated.dispose();

          // #10: initially null
          expect(auth.currentUser, isNull);

          // #7: createUserWithEmailAndPassword
          final email = 'auth-sec2-$suffix@example.test';
          final created = await auth.createUserWithEmailAndPassword(
            email,
            'correct-horse-99',
          );
          final emailUid = created.user!.uid;
          expect(emailUid, isNotEmpty);
          expect(created.additionalUserInfo?.isNewUser, isTrue);
          expect(auth.currentUser?.uid, equals(emailUid));

          await firestore
              .doc('provider_profiles/password/users/$emailUid')
              .set(<String, dynamic>{'provider': 'password'});
          final mainDb = rtdb.PyricDatabase(
            app: session.app,
            bridgeClient: client,
            credentialsProvider: auth,
          );
          await mainDb
              .ref('email_claims/$emailUid')
              .set(<String, Object?>{'unverifiedEmail': email});

          // #9: signOut clears session and revokes owner rule access
          await auth.signOut();
          expect(auth.currentUser, isNull);
          await expectPermissionDenied(
            () => firestore.doc('users/$emailUid').get(),
          );

          // #6: signInWithEmailAndPassword restores existing user with isNewUser == false
          final signedIn = await auth.signInWithEmailAndPassword(
            email,
            'correct-horse-99',
          );
          expect(signedIn.user?.uid, equals(emailUid));
          expect(signedIn.additionalUserInfo?.isNewUser, isFalse);
          expect(auth.currentUser?.uid, equals(emailUid));

          // #8: signInAnonymously creates distinct anonymous session
          await auth.signOut();
          final anonCred = await auth.signInAnonymously();
          final anonUid = anonCred.user!.uid;
          expect(anonUid, isNot(equals(emailUid)));
          expect(anonCred.user?.isAnonymous, isTrue);
          expect(anonCred.user?.email, isNull);
          expect(anonCred.user?.providerData, isEmpty);
          await firestore
              .doc('provider_profiles/anonymous/users/$anonUid')
              .set(<String, dynamic>{'anonymous': true});

          // #49, #51: GoogleAuthProvider.credential + staged identity with custom claims
          await auth.signOut();
          final googleUid = 'google-uid-$suffix';
          await auth.stageSignInResult(
            uid: googleUid,
            providerId: 'google.com',
            email: 'google-$suffix@example.test',
            displayName: 'Google Pilot',
            photoURL: 'https://example.test/google.png',
            emailVerified: true,
            customClaims: <String, dynamic>{'role': 'ops'},
          );
          final googleCred = GoogleAuthProvider.credential(
            idToken: 'staged-google-id-token',
            accessToken: 'staged-google-access-token',
          );
          expect(googleCred.providerId, equals('google.com'));
          final googleResult = await auth.signInWithCredential(googleCred);
          expect(googleResult.user?.uid, equals(googleUid));
          expect(googleResult.additionalUserInfo?.isNewUser, isTrue);
          expect(googleResult.additionalUserInfo?.providerId, equals('google.com'));
          expect(
            (googleResult.user as PyricUserPlatform).customClaims,
            equals(<String, dynamic>{'role': 'ops'}),
          );
          await firestore
              .doc('provider_profiles/google.com/users/$googleUid')
              .set(<String, dynamic>{'ok': true});
          await firestore
              .doc('verified_users/$googleUid')
              .set(<String, dynamic>{'verified': true});
          await firestore
              .doc('role_items/ops/items/google-$suffix')
              .set(<String, dynamic>{'by': googleUid});

          // #50, #51: OAuthProvider.credential with live OIDC idToken decoding (unstaged)
          await auth.signOut();
          final oidcJwt = mintUnsignedOidcJwt(<String, Object?>{
            'sub': 'gh-sub-$suffix',
            'email': 'gh-$suffix@example.test',
            'email_verified': true,
            'name': 'GitHub Octocat',
            'picture': 'https://example.test/octocat.png',
          });
          final githubCred = OAuthProvider('github.com').credential(
            idToken: oidcJwt,
            accessToken: 'gh-access-$suffix',
            rawNonce: 'nonce-$suffix',
          );
          expect(githubCred.providerId, equals('github.com'));
          expect(githubCred.rawNonce, equals('nonce-$suffix'));
          final ghResult = await auth.signInWithCredential(githubCred);
          final ghUid = ghResult.user!.uid;
          expect(ghResult.user?.email, equals('gh-$suffix@example.test'));
          expect(ghResult.user?.displayName, equals('GitHub Octocat'));
          expect(ghResult.user?.isEmailVerified, isTrue);
          await firestore
              .doc('provider_profiles/github.com/users/$ghUid')
              .set(<String, dynamic>{'provider': 'github.com'});
          await firestore
              .doc('verified_users/$ghUid')
              .set(<String, dynamic>{'verified': true});

          // Custom token valid, project mismatch, and malformed token
          final validCustomToken =
              Platform.environment['PYRIC_LIVE_CUSTOM_TOKEN_VALID'] ?? '';
          final mismatchCustomToken =
              Platform.environment['PYRIC_LIVE_CUSTOM_TOKEN_MISMATCH'] ?? '';
          if (validCustomToken.isNotEmpty) {
            final customRes = await auth.signInWithCustomToken(validCustomToken);
            expect(customRes.user?.uid, equals('flutter-custom-uid-01'));
            expect(
              (customRes.user as PyricUserPlatform).customClaims,
              equals(<String, dynamic>{'role': 'ops', 'tier': 'enterprise'}),
            );
            await firestore
                .doc('role_items/ops/items/custom-$suffix')
                .set(<String, dynamic>{'custom': true});
          }
          if (mismatchCustomToken.isNotEmpty) {
            await expectAuthExceptionCode(
              () => auth.signInWithCustomToken(mismatchCustomToken),
              const <String>['custom-token-mismatch', 'invalid-custom-token'],
            );
          }
          await expectAuthExceptionCode(
            () => auth.signInWithCustomToken('not-a-valid-jwt'),
            const <String>['invalid-custom-token'],
          );
        });
      },
    );

    test(
      'auth-flutter#11..14: authStateChanges, idTokenChanges, userChanges, and sendAuthChangesEvent follow exact transition discipline',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final client = session.client;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          final authUids = <String?>[];
          final tokenUids = <String?>[];
          final userNames = <String?>[];

          final authSub = auth.authStateChanges().listen((u) => authUids.add(u?.uid));
          final tokenSub = auth.idTokenChanges().listen((u) => tokenUids.add(u?.uid));
          final userSub = auth
              .userChanges()
              .listen((u) => userNames.add(u == null ? '<null>' : (u.displayName ?? '<none>')));

          await Future<void>.delayed(const Duration(milliseconds: 40));
          expect(authUids, equals(<String?>[null]));
          expect(tokenUids, equals(<String?>[null]));
          expect(userNames, equals(<String?>['<null>']));

          final created = await auth.createUserWithEmailAndPassword(
            'streams-$suffix@example.test',
            'stream-pass-123',
          );
          final uid = created.user!.uid;
          await Future<void>.delayed(const Duration(milliseconds: 40));

          expect(authUids, equals(<String?>[null, uid]));
          expect(tokenUids, equals(<String?>[null, uid]));
          expect(userNames, equals(<String?>['<null>', '<none>']));

          // Forced token refresh fires idTokenChanges + userChanges, NOT authStateChanges
          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': uid,
            'request': <String, dynamic>{
              'customClaims': <String, dynamic>{'role': 'ops'},
            },
          });
          await auth.currentUser!.getIdTokenResult(true);
          await Future<void>.delayed(const Duration(milliseconds: 40));

          expect(authUids, equals(<String?>[null, uid]));
          expect(tokenUids, equals(<String?>[null, uid, uid]));
          expect(userNames.length, equals(3));

          // Profile mutation fires userChanges ONLY (neither authStateChanges nor idTokenChanges)
          await auth.currentUser!.updateProfile(<String, String?>{
            'displayName': 'Stream Verified',
          });
          await Future<void>.delayed(const Duration(milliseconds: 40));

          expect(authUids, equals(<String?>[null, uid]));
          expect(tokenUids, equals(<String?>[null, uid, uid]));
          expect(userNames.last, equals('Stream Verified'));

          // #14: Explicit sendAuthChangesEvent dispatches across all three streams
          auth.sendAuthChangesEvent(session.app.name, auth.currentUser);
          await Future<void>.delayed(const Duration(milliseconds: 40));
          expect(authUids, equals(<String?>[null, uid, uid]));
          expect(tokenUids, equals(<String?>[null, uid, uid, uid]));

          // Sign out appends null to all three streams
          await auth.signOut();
          await Future<void>.delayed(const Duration(milliseconds: 40));
          expect(authUids.last, isNull);
          expect(tokenUids.last, isNull);
          expect(userNames.last, equals('<null>'));

          await authSub.cancel();
          await tokenSub.cancel();
          await userSub.cancel();
        });
      },
    );

    test(
      'auth-flutter#15..19: AuthLens transitions, multi-tenant rule isolation, deep equality, and live Firestore snapshot re-subscription',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final client = session.client;
          final firestore = session.firestore;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          // #18: Deep collection equality on nested token claims
          final lens1 = AuthLens.asUser(
            uid: 'u-eq',
            tenant: 't1',
            token: <String, dynamic>{
              'roles': <String>['ops', 'audit'],
              'meta': <String, dynamic>{'level': 2},
            },
          );
          final lens2 = AuthLens.asUser(
            uid: 'u-eq',
            tenant: 't1',
            token: <String, dynamic>{
              'roles': <String>['ops', 'audit'],
              'meta': <String, dynamic>{'level': 2},
            },
          );
          final lens3 = AuthLens.asUser(
            uid: 'u-eq',
            tenant: 't1',
            token: <String, dynamic>{
              'roles': <String>['viewer'],
              'meta': <String, dynamic>{'level': 2},
            },
          );
          expect(lens1, equals(lens2));
          expect(lens1.hashCode, equals(lens2.hashCode));
          expect(lens1, isNot(equals(lens3)));

          // #15, #16, #17: Multi-tenant AuthLens transitions and live Security Rules isolation
          final observedModes = <String>[];
          final lensSub = auth.authLensChanges.listen((l) => observedModes.add(l.mode));
          await Future<void>.delayed(const Duration(milliseconds: 30));
          expect(auth.currentAuthLens, equals(AuthLens.anon));

          await auth.setTenantId('tenant-alpha-$suffix');
          final tenantEmail = 'tenant-$suffix@example.test';
          final tenantCred = await auth.createUserWithEmailAndPassword(
            tenantEmail,
            'tenant-pass-123',
          );
          final tenantUid = tenantCred.user!.uid;
          expect(auth.currentAuthLens.mode, equals('as'));
          expect(auth.currentAuthLens.tenant, equals('tenant-alpha-$suffix'));

          await firestore
              .doc('tenant_rooms/tenant-alpha-$suffix/rooms/lobby')
              .set(<String, dynamic>{'host': tenantUid});
          await expectPermissionDenied(
            () => firestore
                .doc('tenant_rooms/tenant-beta-$suffix/rooms/lobby')
                .set(<String, dynamic>{'host': tenantUid}),
          );

          // Cross-tenant signInWithEmailAndPassword must reject credentials from another tenant pool
          await auth.signOut();
          await auth.setTenantId('tenant-beta-$suffix');
          await expectAuthExceptionCode(
            () => auth.signInWithEmailAndPassword(tenantEmail, 'tenant-pass-123'),
            const <String>['invalid-credential', 'user-not-found'],
          );
          await auth.setTenantId(null);

          // #19: Live Firestore snapshot re-subscription supervisor across auth & claim transitions
          auth.switchAuthLens(AuthLens.admin);
          expect(auth.currentAuthLens, equals(AuthLens.admin));
          await firestore
              .doc('role_items/ops/items/watch-$suffix')
              .set(<String, dynamic>{'stage': 'initial'});
          auth.switchAuthLens(null);

          final supCred = await auth.createUserWithEmailAndPassword(
            'supervisor-$suffix@example.test',
            'sup-pass-123',
          );
          final supUid = supCred.user!.uid;
          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': supUid,
            'request': <String, dynamic>{
              'customClaims': <String, dynamic>{'role': 'ops'},
            },
          });
          await auth.currentUser!.getIdTokenResult(true);

          final stages = <String?>[];
          final denialCompleter = Completer<Object>();
          final snapSub = firestore
              .doc('role_items/ops/items/watch-$suffix')
              .snapshots(listenSource: ListenSource.defaultSource)
              .listen(
            (snap) => stages.add(snap.data()?['stage'] as String?),
            onError: (Object err) {
              if (!denialCompleter.isCompleted) {
                denialCompleter.complete(err);
              }
            },
          );

          await Future<void>.delayed(const Duration(milliseconds: 120));
          expect(stages, contains('initial'));

          await firestore
              .doc('role_items/ops/items/watch-$suffix')
              .update(<FieldPath, dynamic>{FieldPath.fromString('stage'): 'updated'});
          await Future<void>.delayed(const Duration(milliseconds: 120));
          expect(stages, contains('updated'));

          // Signing out transitions lens to anon -> supervisor re-subscribes and hits rules denial
          await auth.signOut();
          final streamErr = await denialCompleter.future.timeout(
            const Duration(seconds: 5),
          );
          expect(streamErr, isA<PyricBridgeException>());

          await snapSub.cancel();
          await lensSub.cancel();
          expect(observedModes, containsAll(<String>['anon', 'as', 'admin']));
        });
      },
    );

    test(
      'auth-flutter#20..29: UserPlatform identity properties, phoneNumber, emailVerified, providerData, tenantId, and metadata timestamps',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final client = session.client;
          final firestore = session.firestore;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          final seededUid = 'identity-uid-$suffix';
          final seededEmail = 'identity-$suffix@example.test';
          final tenant = 'tenant-id-$suffix';

          await client.op('auth.adminCreateUser', <String, dynamic>{
            'request': <String, dynamic>{
              'uid': seededUid,
              'email': seededEmail,
              'password': 'identity-password-99',
              'displayName': 'Ada Lovelace',
              'photoUrl': 'https://example.test/ada.png',
              'phoneNumber': '+14155550199',
              'emailVerified': true,
              'tenantId': tenant,
            },
          });

          await auth.setTenantId(tenant);
          final cred = await auth.signInWithEmailAndPassword(
            seededEmail,
            'identity-password-99',
          );
          final user = cred.user!;

          expect(user.uid, equals(seededUid));
          expect(user.email, equals(seededEmail));
          expect(user.displayName, equals('Ada Lovelace'));
          expect(user.photoURL, equals('https://example.test/ada.png'));
          expect(user.phoneNumber, equals('+14155550199'));
          expect(user.isAnonymous, isFalse);
          expect(user.isEmailVerified, isTrue);
          expect(user.tenantId, equals(tenant));
          expect(user.providerData, isNotEmpty);
          expect(user.providerData.first.providerId, equals('password'));
          expect(user.providerData.first.email, equals(seededEmail));
          expect(user.metadata.creationTime, isNotNull);
          expect(user.metadata.lastSignInTime, isNotNull);

          // Verified email user satisfies live verified_users/{uid} Firestore rule
          await firestore
              .doc('verified_users/$seededUid')
              .set(<String, dynamic>{'verified': true});
        });
      },
    );
  });
}
