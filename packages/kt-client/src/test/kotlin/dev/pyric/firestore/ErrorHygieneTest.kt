package dev.pyric.firestore

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class ErrorHygieneTest {
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)
        app = FirebaseApp.initializeApp(
            options = FirebaseOptions.Builder()
                .setProjectId("error-hygiene-test")
                .setApplicationId("1:123:android:abc")
                .setApiKey("test-api-key")
                .build(),
            name = "error-hygiene-app"
        )
        auth = FirebaseAuth(app, bridgeClient)
    }

    @AfterEach
    fun tearDown() {
        runBlocking { bridgeClient.disconnect() }
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun firestoreExceptionToStringOmitsRawDenialContextWhileKeepingProperty() {
        val largeContext = mapOf(
            "rule" to mapOf("line" to 42, "file" to "firestore.rules"),
            "expressionTrace" to List(200) { "request.auth.uid == resource.data.ownerId" }
        )
        val ex = FirebaseFirestoreException(
            message = "Permission denied on playlists/pl-bob-only",
            code = FirebaseFirestoreException.Code.PERMISSION_DENIED,
            denialContext = largeContext
        )

        assertSame(largeContext, ex.denialContext)
        assertEquals(
            "FirebaseFirestoreException(PERMISSION_DENIED): Permission denied on playlists/pl-bob-only",
            ex.toString()
        )
        assertFalse(ex.toString().contains("denialContext"))
        assertFalse(ex.toString().contains("expressionTrace"))
    }

    @Test
    fun authWrapExceptionParsesBlockingFunctionPermissionDeniedJson() {
        val raw = FirebaseFirestoreException(
            message = """{"error":{"message":"Your email address is not on the allowlist.","status":"PERMISSION_DENIED"}}""",
            code = FirebaseFirestoreException.Code.INTERNAL,
            wireCode = "auth/internal-error"
        )
        val wrapped = auth.wrapException(raw)
        assertTrue(wrapped is FirebaseAuthException)
        val authEx = wrapped as FirebaseAuthException
        assertEquals("ERROR_PERMISSION_DENIED", authEx.errorCode)
        assertEquals("[ERROR_PERMISSION_DENIED] Your email address is not on the allowlist.", authEx.message)
        assertFalse((authEx.message ?: "").contains("{\"error\""))
    }

    @Test
    fun authWrapExceptionHandlesPrefixedJsonAndFailedPrecondition() {
        val raw = FirebaseFirestoreException(
            message = """HTTP 400: {"error":{"message":"Invite code required.","status":"FAILED_PRECONDITION"}}""",
            code = FirebaseFirestoreException.Code.INTERNAL,
            wireCode = "auth/internal-error"
        )
        val authEx = auth.wrapException(raw) as FirebaseAuthException
        assertEquals("ERROR_FAILED_PRECONDITION", authEx.errorCode)
        assertEquals("[ERROR_FAILED_PRECONDITION] Invite code required.", authEx.message)
    }

    @Test
    fun authWrapExceptionPreservesSpecificAuthCodeOverBlockingStatus() {
        val raw = FirebaseFirestoreException(
            message = """{"error":{"message":"Account disabled by policy.","status":"PERMISSION_DENIED"}}""",
            code = FirebaseFirestoreException.Code.PERMISSION_DENIED,
            wireCode = "auth/user-disabled"
        )
        val authEx = auth.wrapException(raw) as FirebaseAuthException
        assertEquals("ERROR_USER_DISABLED", authEx.errorCode)
        assertEquals("[ERROR_USER_DISABLED] Account disabled by policy.", authEx.message)
    }

    @Test
    fun authWrapExceptionFallsBackGracefullyOnMalformedJson() {
        val raw = FirebaseFirestoreException(
            message = "{not valid json",
            code = FirebaseFirestoreException.Code.INTERNAL,
            wireCode = "auth/internal-error"
        )
        val authEx = auth.wrapException(raw) as FirebaseAuthException
        assertEquals("ERROR_UNKNOWN", authEx.errorCode)
        assertEquals("[ERROR_UNKNOWN] {not valid json", authEx.message)
    }
}
