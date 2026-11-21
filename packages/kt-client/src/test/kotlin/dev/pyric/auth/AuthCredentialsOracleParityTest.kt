package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.EmailAuthCredential
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.GoogleAuthCredential
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthCredential
import com.google.firebase.auth.OAuthProvider
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class AuthCredentialsOracleParityTest {
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()

    @BeforeEach
    fun setUp() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        sentOps.clear()
        transport = InMemoryBridgeTransport()
        transport.onServerReceive { raw ->
            val msg = JsonCodec.decodeMap(raw)
            when (msg["type"]) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    handleMockOp(id, op)
                }
            }
        }
        bridgeClient = PyricBridgeClient(transport)
        app = FirebaseApp.initializeApp(
            "cred-parity-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-cred-parity")
                .setApiKey("demo-key")
                .setApplicationId("dev.pyric.cred.test")
                .build()
        )
        auth = FirebaseAuth.getInstance(app, bridgeClient)
    }

    @AfterEach
    fun tearDown() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun handleMockOp(id: String, op: Map<String, Any?>) {
        when (op["method"] as String) {
            "auth.signInAnonymously" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"u-anon-1","isAnonymous":true,"providerId":"firebase","providerData":[]}}}"""
                )
            }
            "auth.linkWithCredential" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"u-anon-1","email":"linked@example.com","isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"linked@example.com","email":"linked@example.com","providerId":"password"}]},"operationType":"link","providerId":null}}"""
                )
            }
            "auth.reauthenticateWithCredential" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"u-anon-1","email":"linked@example.com","isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"linked@example.com","email":"linked@example.com","providerId":"password"}]},"operationType":"reauthenticate","providerId":null}}"""
                )
            }
            "auth.updatePassword" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"u-anon-1","email":"linked@example.com","isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"linked@example.com","email":"linked@example.com","providerId":"password"}]}}"""
                )
            }
            "auth.updateEmail" -> {
                val email = op["email"] as? String ?: "updated@example.com"
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"u-anon-1","email":"$email","isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"$email","email":"$email","providerId":"password"}]}}"""
                )
            }
            "auth.unlink" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"u-anon-1","email":null,"isAnonymous":false,"providerId":"firebase","providerData":[]}}"""
                )
            }
            "auth.signInWithCredential" -> {
                @Suppress("UNCHECKED_CAST")
                val cred = op["credential"] as? Map<String, Any?> ?: op
                val idToken = cred["idToken"] as? String
                if (idToken == "synthetic-unconfigured") {
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/no-mock-configured","message":"No mock configured"}}"""
                    )
                } else {
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"u-google-1","email":"g@example.com","isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"g-sub","email":"g@example.com","providerId":"google.com"}]},"additionalUserInfo":{"providerId":"google.com","isNewUser":true}}}"""
                    )
                }
            }
            "auth.getIdTokenResult" -> {
                transport.sendToClient(
                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"jwt","claims":{"sub":"u-anon-1"},"signInProvider":"password"}}"""
                )
            }
            else -> {
                transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
            }
        }
    }

    @Test
    fun `GoogleAuthProvider returns GoogleAuthCredential with signInMethod and upstream validation`() {
        assertEquals("google.com", GoogleAuthProvider.PROVIDER_ID)
        assertEquals("google.com", GoogleAuthProvider.GOOGLE_SIGN_IN_METHOD)

        val cred = GoogleAuthProvider.getCredential("gid-1", "gacc-1")
        assertTrue(cred is GoogleAuthCredential)
        assertFalse(cred is OAuthCredential)
        val googleCred = cred as GoogleAuthCredential
        assertEquals("google.com", googleCred.provider)
        assertEquals("google.com", googleCred.signInMethod)
        assertEquals("gid-1", googleCred.idToken)
        assertEquals("gacc-1", googleCred.accessToken)
        assertEquals("google.com", googleCred.toWireMap()["signInMethod"])

        val accessOnly = GoogleAuthProvider.getCredential(null, "gacc-only") as GoogleAuthCredential
        assertNull(accessOnly.idToken)
        assertEquals("gacc-only", accessOnly.accessToken)

        val bothNull = assertThrows(IllegalArgumentException::class.java) {
            GoogleAuthProvider.getCredential(null, null)
        }
        assertEquals("Must specify an idToken or an accessToken.", bothNull.message)

        val emptyId = assertThrows(IllegalArgumentException::class.java) {
            GoogleAuthProvider.getCredential("", "gacc-1")
        }
        assertEquals("idToken cannot be empty", emptyId.message)

        val emptyAccess = assertThrows(IllegalArgumentException::class.java) {
            GoogleAuthProvider.getCredential("gid-1", "")
        }
        assertEquals("accessToken cannot be empty", emptyAccess.message)
    }

    @Test
    fun `OAuthProvider and CredentialBuilder expose signInMethod secret getters and validation`() {
        val github = OAuthProvider.getCredential("github.com", "gh-id", "gh-acc") as OAuthCredential
        assertEquals("github.com", github.provider)
        assertEquals("github.com", github.signInMethod)
        assertEquals("gh-id", github.idToken)
        assertEquals("gh-acc", github.accessToken)
        assertNull(github.secret)

        val builder = OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("apple-id", "nonce-42")
            .setAccessToken("apple-acc")
        assertEquals("apple-id", builder.idToken)
        assertEquals("apple-acc", builder.accessToken)
        val built = builder.build() as OAuthCredential
        assertEquals("apple.com", built.provider)
        assertEquals("apple.com", built.signInMethod)
        assertEquals("nonce-42", built.rawNonce)
        assertEquals("apple.com", built.toWireMap()["signInMethod"])

        assertThrows(IllegalArgumentException::class.java) {
            OAuthProvider.newCredentialBuilder("")
        }
        val missingTokens = assertThrows(IllegalArgumentException::class.java) {
            OAuthProvider.newCredentialBuilder("apple.com").build()
        }
        assertEquals("Must specify an idToken or an accessToken.", missingTokens.message)
        assertThrows(IllegalArgumentException::class.java) {
            OAuthProvider.getCredential("github.com", null, null)
        }
    }

    @Test
    fun `EmailAuthProvider creates password and emailLink credentials with signInMethod`() {
        assertEquals("password", EmailAuthProvider.PROVIDER_ID)
        assertEquals("password", EmailAuthProvider.EMAIL_PASSWORD_SIGN_IN_METHOD)
        assertEquals("emailLink", EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD)

        val pwCred = EmailAuthProvider.getCredential("alice@example.com", "Secret123!")
        assertTrue(pwCred is EmailAuthCredential)
        assertEquals("password", pwCred.provider)
        assertEquals("password", pwCred.signInMethod)
        assertEquals("password", pwCred.toWireMap()["signInMethod"])
        assertEquals("alice@example.com", pwCred.toWireMap()["email"])

        val linkCred = EmailAuthProvider.getCredentialWithLink(
            "alice@example.com",
            "https://example.firebaseapp.com/__/auth/action?mode=signIn&oobCode=code123"
        )
        assertEquals("password", linkCred.provider)
        assertEquals("emailLink", linkCred.signInMethod)
        assertEquals("emailLink", linkCred.toWireMap()["signInMethod"])

        assertThrows(IllegalArgumentException::class.java) {
            EmailAuthProvider.getCredential("", "Secret123!")
        }
        assertThrows(IllegalArgumentException::class.java) {
            EmailAuthProvider.getCredential("alice@example.com", "")
        }
        assertThrows(IllegalArgumentException::class.java) {
            EmailAuthProvider.getCredentialWithLink("alice@example.com", "")
        }
    }

    @Test
    fun `languageCode linking reauth updatePassword unlink and synthetic credential error parity`() {
        assertNull(auth.languageCode)
        auth.setLanguageCode("de")
        assertEquals("de", auth.languageCode)
        auth.useAppLanguage()
        assertNotNull(auth.languageCode)
        assertTrue(auth.languageCode.orEmpty().isNotBlank())

        val anon = Tasks.await(auth.signInAnonymously()).user!!
        assertTrue(anon.isAnonymous)

        val emailCred = EmailAuthProvider.getCredential("linked@example.com", "Secret123!")
        val linked = Tasks.await(anon.linkWithCredential(emailCred)).user!!
        assertEquals("u-anon-1", linked.uid)
        assertFalse(linked.isAnonymous)
        assertEquals(listOf("firebase", "password"), linked.providerData.map { it.providerId })

        val alreadyLinkedErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(linked.linkWithCredential(EmailAuthProvider.getCredential("other@example.com", "Secret123!")))
        }
        val cause = alreadyLinkedErr.cause
        assertTrue(cause is FirebaseException)
        assertFalse(cause is FirebaseAuthException)
        assertEquals("User has already been linked to the given provider.", cause?.message)

        val reauthRes = Tasks.await(linked.reauthenticateAndRetrieveData(emailCred))
        assertEquals("u-anon-1", reauthRes.user?.uid)
        Tasks.await(linked.reauthenticate(emailCred))
        Tasks.await(linked.updatePassword("UpdatedSecret456!"))
        Tasks.await(linked.updateEmail("updated@example.com"))
        assertEquals("updated@example.com", linked.email)

        val unlinked = Tasks.await(linked.unlink(EmailAuthProvider.PROVIDER_ID)).user!!
        assertEquals(listOf("firebase"), unlinked.providerData.map { it.providerId })

        val syntheticErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(
                auth.signInWithCredential(
                    GoogleAuthProvider.getCredential("synthetic-unconfigured", "acc-token")
                )
            )
        }
        val invalidCred = syntheticErr.cause
        assertTrue(invalidCred is FirebaseAuthInvalidCredentialsException)
        assertEquals("ERROR_INVALID_CREDENTIAL", (invalidCred as FirebaseAuthInvalidCredentialsException).errorCode)
    }
}
