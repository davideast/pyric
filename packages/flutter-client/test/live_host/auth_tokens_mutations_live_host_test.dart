import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart' as rtdb;

import '../auth/mock_bridge_helper.dart';
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

  group('Pyric Flutter Auth live-host conformance (Sections 6-10)', () {
    test(
      'InternalUserDetails wire deserializer and MultiFactorPlatform contract hold locally',
      () async {
        setupMockFirebase();
        final harness = MockBridgeHarness();
        final dummyClient = harness.createClient();
        final dummyAuth = PyricFirebaseAuthPlatform(bridgeClient: dummyClient);
        try {
          final user = PyricUserPlatform.fromWire(
            auth: dummyAuth,
            client: dummyClient,
            data: <String, dynamic>{
              'uid': 'model-u1',
              'email': 'model@example.test',
              'displayName': 'Model User',
              'photoURL': 'https://example.test/m.png',
              'creationTimestamp': 1725400000000,
              'lastSignInTimestamp': 1725400050000,
              'providerData': <Map<String, dynamic>>[
                <String, dynamic>{
                  'providerId': 'google.com',
                  'uid': 'g-sub-1',
                  'email': 'model@example.test',
                },
              ],
            },
          );
          expect(user.uid, equals('model-u1'));
          expect(user.providerData.single.providerId, equals('google.com'));
          expect(user.multiFactor, isA<MultiFactorPlatform>());
        } finally {
          await dummyAuth.dispose();
          await dummyClient.disconnect();
          await harness.dispose();
        }
      },
    );

    test(
      'auth-flutter#30..33: getIdToken, getIdTokenResult, customClaims, and forced token refresh stream dispatch on live host',
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

          final cred = await auth.createUserWithEmailAndPassword(
            'tokens-$suffix@example.test',
            'token-pass-123',
          );
          final user = cred.user! as PyricUserPlatform;
          final uid = user.uid;

          // #30: Cached JWT vs forced-refresh JWT after admin claim escalation
          final initialJwt = await user.getIdToken(false);
          expect(initialJwt, isNotNull);
          final initialPayload = decodeJwtPayload(initialJwt!);
          expect(initialPayload['user_id'], equals(uid));
          expect(initialPayload['role'], isNull);

          await expectPermissionDenied(
            () => firestore
                .doc('role_items/ops/items/tok-$suffix')
                .set(<String, dynamic>{'ok': true}),
          );

          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': uid,
            'request': <String, dynamic>{
              'customClaims': <String, dynamic>{'role': 'ops', 'level': 7},
            },
          });

          // Cached token before forceRefresh still carries previous claims
          final cachedJwt = await user.getIdToken(false);
          expect(decodeJwtPayload(cachedJwt!)['role'], isNull);

          final tokenEvents = <String?>[];
          final tokenSub = auth.idTokenChanges().listen((u) => tokenEvents.add(u?.uid));
          await Future<void>.delayed(const Duration(milliseconds: 30));

          // Forced refresh via getIdToken(true) mints updated JWT and updates customClaims + lens
          final refreshedJwt = await user.getIdToken(true);
          final refreshedPayload = decodeJwtPayload(refreshedJwt!);
          expect(refreshedPayload['role'], equals('ops'));
          expect(refreshedPayload['level'], equals(7));
          expect(
            user.customClaims,
            equals(<String, dynamic>{'role': 'ops', 'level': 7}),
          );

          await firestore
              .doc('role_items/ops/items/tok-$suffix')
              .set(<String, dynamic>{'ok': true});
          final shard01 = rtdb.PyricDatabase.instanceFor(
            app: session.app,
            databaseURL: 'https://shard-01.firebaseio.com',
            bridgeClient: client,
            credentialsProvider: auth,
          );
          await shard01
              .ref('ops/op-$suffix')
              .set(<String, Object?>{'actor': uid, 'level': 7});

          // #31..33: getIdTokenResult returns structured claims & timestamps and dispatches refresh
          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': uid,
            'request': <String, dynamic>{
              'customClaims': <String, dynamic>{'role': 'ops', 'level': 9},
            },
          });
          final tokenResult = await user.getIdTokenResult(true);
          expect(tokenResult.token, isNotEmpty);
          expect(tokenResult.signInProvider, equals('password'));
          expect(tokenResult.claims?['role'], equals('ops'));
          expect(tokenResult.claims?['level'], equals(9));
          expect(tokenResult.authTime, isNotNull);
          expect(tokenResult.issuedAtTime, isNotNull);
          expect(tokenResult.expirationTime, isNotNull);
          expect(
            tokenResult.expirationTime!.isAfter(tokenResult.issuedAtTime!),
            isTrue,
          );
          expect(
            user.customClaims,
            equals(<String, dynamic>{'role': 'ops', 'level': 9}),
          );

          await Future<void>.delayed(const Duration(milliseconds: 30));
          expect(tokenEvents.where((id) => id == uid).length, greaterThanOrEqualTo(3));
          await tokenSub.cancel();
        });
      },
    );

    test(
      'auth-flutter#34..38: updateProfile (set, partial preserve, null clear), reload, updateEmail, updatePassword, and delete on live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final client = session.client;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          final initialEmail = 'mutate-$suffix@example.test';
          final created = await auth.createUserWithEmailAndPassword(
            initialEmail,
            'initial-pass-123',
          );
          final uid = created.user!.uid;

          // #34: updateProfile set -> partial update -> explicit null clear
          await auth.currentUser!.updateProfile(<String, String?>{
            'displayName': 'Grace Hopper',
            'photoURL': 'https://example.test/grace.png',
          });
          expect(auth.currentUser?.displayName, equals('Grace Hopper'));
          expect(auth.currentUser?.photoURL, equals('https://example.test/grace.png'));

          await auth.currentUser!.updateProfile(<String, String?>{
            'displayName': 'Rear Admiral Hopper',
          });
          expect(auth.currentUser?.displayName, equals('Rear Admiral Hopper'));
          expect(auth.currentUser?.photoURL, equals('https://example.test/grace.png'));

          await auth.currentUser!.updateProfile(<String, String?>{
            'photoURL': null,
          });
          expect(auth.currentUser?.displayName, equals('Rear Admiral Hopper'));
          expect(auth.currentUser?.photoURL, isNull);

          // #35: reload picks up out-of-band adminUpdateUser changes while preserving metadata
          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': uid,
            'request': <String, dynamic>{
              'displayName': 'Reloaded Hopper',
              'emailVerified': true,
            },
          });
          await auth.currentUser!.reload();
          expect(auth.currentUser?.displayName, equals('Reloaded Hopper'));
          expect(auth.currentUser?.isEmailVerified, isTrue);
          expect(auth.currentUser?.metadata.creationTime, isNotNull);

          // #37: updateEmail changes login credential and rejects old email
          final updatedEmail = 'mutated-$suffix@example.test';
          await auth.currentUser!.updateEmail(updatedEmail);
          expect(auth.currentUser?.email, equals(updatedEmail));

          await auth.signOut();
          await expectAuthExceptionCode(
            () => auth.signInWithEmailAndPassword(initialEmail, 'initial-pass-123'),
            const <String>['invalid-credential', 'user-not-found'],
          );
          await auth.signInWithEmailAndPassword(updatedEmail, 'initial-pass-123');
          expect(auth.currentUser?.uid, equals(uid));

          // #38: updatePassword rotates secret and rejects old password
          await auth.currentUser!.updatePassword('rotated-pass-456');
          await auth.signOut();
          await expectAuthExceptionCode(
            () => auth.signInWithEmailAndPassword(updatedEmail, 'initial-pass-123'),
            const <String>['invalid-credential', 'wrong-password'],
          );
          await auth.signInWithEmailAndPassword(updatedEmail, 'rotated-pass-456');
          expect(auth.currentUser?.uid, equals(uid));

          // #35 invalidation branch: disabling account causes reload() to throw user-disabled and sign out
          final disabledCred = await auth.createUserWithEmailAndPassword(
            'disable-reload-$suffix@example.test',
            'disable-pass-123',
          );
          final disabledUid = disabledCred.user!.uid;
          await client.op('auth.adminUpdateUser', <String, dynamic>{
            'uid': disabledUid,
            'request': <String, dynamic>{'disabled': true},
          });
          await expectAuthExceptionCode(
            () => auth.currentUser!.reload(),
            const <String>['user-disabled'],
          );
          expect(auth.currentUser, isNull);

          // #36: delete removes account on host, clears currentUser, and prevents future sign-in
          await auth.signInWithEmailAndPassword(updatedEmail, 'rotated-pass-456');
          await auth.currentUser!.delete();
          expect(auth.currentUser, isNull);
          await expectAuthExceptionCode(
            () => auth.signInWithEmailAndPassword(updatedEmail, 'rotated-pass-456'),
            const <String>['invalid-credential', 'user-not-found'],
          );
        });
      },
    );

    test(
      'auth-flutter#39..45: UserCredentialPlatform, additionalUserInfo, setLanguageCode, useAuthEmulator live redirect, and setPersistence',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (session) async {
          final auth = session.auth;
          final suffix = DateTime.now().microsecondsSinceEpoch;

          // #39..42: UserCredentialPlatform.user, additionalUserInfo, InternalUserDetails, MultiFactorPlatform
          final email = 'ext-$suffix@example.test';
          final created = await auth.createUserWithEmailAndPassword(
            email,
            'ext-pass-123',
          );
          expect(created.user, isNotNull);
          expect(created.additionalUserInfo?.isNewUser, isTrue);
          expect(created.user!.multiFactor, isA<MultiFactorPlatform>());

          await auth.signOut();
          final signedInAgain = await auth.signInWithEmailAndPassword(
            email,
            'ext-pass-123',
          );
          expect(signedInAgain.user?.uid, equals(created.user?.uid));
          expect(signedInAgain.additionalUserInfo?.isNewUser, isFalse);

          // #43: setLanguageCode configures locale and supports null reset
          await auth.setLanguageCode('fr-CA');
          expect(auth.languageCode, equals('fr-CA'));
          await auth.setLanguageCode(null);
          expect(auth.languageCode, isNull);

          // #45: setPersistence supports all 4 FlutterFire Persistence enum values on live host
          for (final mode in Persistence.values) {
            await auth.setPersistence(mode);
          }

          // #44: useAuthEmulator redirects a default PyricFirebaseAuthPlatform() to the live loopback port
          final emulatorApp = await Firebase.initializeApp(
            name: 'emulator-redirect-$suffix',
            options: liveAuthOptions,
          );
          final standaloneAuth = PyricFirebaseAuthPlatform(appInstance: emulatorApp);
          try {
            await standaloneAuth.useAuthEmulator(bridgeUri.host, bridgeUri.port);
            expect(standaloneAuth.emulatorHost, equals(bridgeUri.host));
            expect(standaloneAuth.emulatorPort, equals(bridgeUri.port));

            final emuCred = await standaloneAuth.createUserWithEmailAndPassword(
              'emulator-$suffix@example.test',
              'emu-pass-123',
            );
            expect(emuCred.user?.email, equals('emulator-$suffix@example.test'));
            expect(standaloneAuth.bridgeClient.isConnected, isTrue);
          } finally {
            await standaloneAuth.dispose();
          }
        });
      },
    );

    test(
      'auth-flutter#46..48: FirebaseAuthException live code mapping, bridge auth codecs, and multi-client session isolation',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) {
          return;
        }

        await withLiveAuthSession(bridgeUri, (sessionA) async {
          await withLiveAuthSession(bridgeUri, (sessionB) async {
            final authA = sessionA.auth;
            final authB = sessionB.auth;
            final clientA = sessionA.client;
            final clientB = sessionB.client;
            final suffix = DateTime.now().microsecondsSinceEpoch;

            // #48: Two independent WebSocket clients receive distinct clientSessionIds
            expect(clientA.clientSessionId, isNotNull);
            expect(clientB.clientSessionId, isNotNull);
            expect(clientA.clientSessionId, isNot(equals(clientB.clientSessionId)));

            // #46: Error code normalization across live validation, collision, credential, disabled, and mock errors
            await expectAuthExceptionCode(
              () => authA.createUserWithEmailAndPassword('not-an-email', 'valid-pass-123'),
              const <String>['invalid-email'],
            );
            await expectAuthExceptionCode(
              () => authA.createUserWithEmailAndPassword('weak-$suffix@example.test', '123'),
              const <String>['weak-password'],
            );

            final aliceEmail = 'alice-iso-$suffix@example.test';
            final bobEmail = 'bob-iso-$suffix@example.test';
            final aliceCred = await authA.createUserWithEmailAndPassword(
              aliceEmail,
              'alice-pass-123',
            );
            final bobCred = await authB.createUserWithEmailAndPassword(
              bobEmail,
              'bob-pass-123',
            );
            final aliceUid = aliceCred.user!.uid;
            final bobUid = bobCred.user!.uid;

            await expectAuthExceptionCode(
              () => authB.createUserWithEmailAndPassword(aliceEmail, 'another-pass-123'),
              const <String>['email-already-in-use'],
            );
            await expectAuthExceptionCode(
              () => authB.signInWithEmailAndPassword(aliceEmail, 'wrong-password-999'),
              const <String>['invalid-credential', 'wrong-password'],
            );
            await expectAuthExceptionCode(
              () => authB.signInWithCredential(
                GoogleAuthProvider.credential(accessToken: 'opaque-unstaged-token'),
              ),
              const <String>['no-mock-configured', 'invalid-credential'],
            );

            // #48: Concurrent session isolation in Firestore Security Rules
            await sessionA.firestore
                .doc('users/$aliceUid')
                .set(<String, dynamic>{'owner': 'alice'});
            await sessionB.firestore
                .doc('users/$bobUid')
                .set(<String, dynamic>{'owner': 'bob'});
            await expectPermissionDenied(
              () => sessionA.firestore.doc('users/$bobUid').get(),
            );
            await expectPermissionDenied(
              () => sessionB.firestore.doc('users/$aliceUid').get(),
            );

            // Signing out Client A leaves Client B signed in as Bob
            await authA.signOut();
            expect(authA.currentUser, isNull);
            expect(authB.currentUser?.uid, equals(bobUid));
            final bobSnap = await sessionB.firestore.doc('users/$bobUid').get();
            expect(bobSnap.data()?['owner'], equals('bob'));

            // Out-of-band account deletion invalidates Client B on forced token refresh
            await clientA.op('auth.adminDeleteUser', <String, dynamic>{'uid': bobUid});
            await expectAuthExceptionCode(
              () => authB.currentUser!.getIdToken(true),
              const <String>['user-token-expired', 'user-not-found'],
            );
            expect(authB.currentUser, isNull);

            // #47: Direct PyricBridgeAuthOps wire RPC round-trip
            final codecEmail = 'codec-$suffix@example.test';
            final rawCreated = await clientA.authCreateUser(
              codecEmail,
              'codec-pass-123',
            ) as Map;
            final codecUid = (rawCreated['user'] as Map)['uid'] as String;
            final currentWire = await clientA.authGetCurrentUser() as Map;
            expect(currentWire['uid'], equals(codecUid));
            final rawToken = await clientA.authGetIdToken(forceRefresh: false);
            expect(rawToken, isNotEmpty);
            final rawTokenRes = await clientA.authGetIdTokenResult(forceRefresh: false);
            expect(rawTokenRes['claims'], isA<Map>());
            await clientA.authUpdateProfile(displayName: 'Codec User');
            final allUsers = await clientA.authListUsers();
            expect(allUsers.any((u) => u['uid'] == codecUid), isTrue);
            await clientA.authSignOut();
            expect(await clientA.authGetCurrentUser(), isNull);
            final restored = await clientA.authRestorePortSession(codecUid) as Map?;
            expect(restored?['uid'], equals(codecUid));
            await clientA.authSignOut();
          });
        });
      },
    );
  });
}
