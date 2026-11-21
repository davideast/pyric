package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.StreamResponse
import com.google.firebase.functions.functions
import com.google.firebase.functions.getHttpsCallable
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.net.URL
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class FunctionsLiveHostConformanceTest {
    private var functionsBaseUrl: String? = null

    @BeforeEach
    fun setUp() {
        val requireLive = System.getenv("PYRIC_REQUIRE_FUNCTIONS_LIVE") == "1"
        val baseUrl = System.getenv("PYRIC_FUNCTIONS_BASE_URL")?.trim()
        val bridgeUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")?.trim()
        if (baseUrl.isNullOrEmpty() || bridgeUrl.isNullOrEmpty()) {
            if (requireLive) {
                throw IllegalStateException(
                    "PYRIC_REQUIRE_FUNCTIONS_LIVE=1 requires PYRIC_FUNCTIONS_BASE_URL and PYRIC_LIVE_BRIDGE_URL"
                )
            }
            functionsBaseUrl = null
            return
        }
        functionsBaseUrl = baseUrl.trimEnd('/')
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun newFunctionsApp(prefix: String): FirebaseApp {
        return FirebaseApp.initializeApp(
            "$prefix-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-functions-live-key")
                .setApplicationId(APP_ID)
                .build()
        )
    }

    @Test
    @DisplayName("functions-kotlin: v2 & v1 onCall round-trips, Int64Value Long, Auth Bearer, AppCheck enforcement & consume, HttpsError, timeout, URLs, and SSE streaming")
    fun `proves v2 and v1 callable functions Auth AppCheck HttpsError timeout and SSE streaming against live Pyric host`() = runBlocking {
        val activeBaseUrl = functionsBaseUrl ?: return@runBlocking
        val app = newFunctionsApp("kt-live-functions")
        val functions = Firebase.functions(app)

        // 1. Signed-out v2 onCall & v1 https.onCall echo + 64-bit Long Int64Value round-trip
        val v2Anon = Tasks.await(
            functions.getHttpsCallable("pyricCallableEcho").call(
                mapOf("greeting" to "hello-v2", "largeLong" to 9007199254740991L)
            ),
            15,
            TimeUnit.SECONDS
        )
        @Suppress("UNCHECKED_CAST")
        val v2AnonReport = v2Anon.data as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val v2AnonAuth = v2AnonReport["auth"] as Map<String, Any?>
        assertEquals(false, v2AnonAuth["present"])
        @Suppress("UNCHECKED_CAST")
        val echoedMap = v2AnonReport["data"] as Map<String, Any?>
        assertEquals("hello-v2", echoedMap["greeting"])
        assertEquals(9007199254740991L, (echoedMap["largeLong"] as Number).toLong())

        val largeReturn = Tasks.await(
            functions.getHttpsCallable("pyricCallableEcho").call(
                mapOf("mode" to "return", "value" to "large-integer")
            ),
            15,
            TimeUnit.SECONDS
        )
        assertEquals(9007199254740992L, (largeReturn.data as Number).toLong())

        val v1Res = Tasks.await(
            functions.getHttpsCallable("pyricCallableV1").call(mapOf("gen" to 1)),
            15,
            TimeUnit.SECONDS
        )
        @Suppress("UNCHECKED_CAST")
        val v1Report = v1Res.data as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        assertEquals(1, (v1Report["data"] as Map<String, Any?>)["gen"])

        // 2. Signed-in FirebaseAuth automatically attaches verified Authorization: Bearer <idToken>
        val auth = FirebaseAuth.getInstance(app)
        val email = "kt-fn-${System.nanoTime()}@example.com"
        Tasks.await(
            auth.createUserWithEmailAndPassword(email, "CallablePass!123"),
            10,
            TimeUnit.SECONDS
        )
        val authedEcho = Tasks.await(
            functions.getHttpsCallable("pyricCallableEcho").call(mapOf("check" to "auth")),
            15,
            TimeUnit.SECONDS
        )
        @Suppress("UNCHECKED_CAST")
        val authedReport = authedEcho.data as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val authInfo = authedReport["auth"] as Map<String, Any?>
        assertEquals(true, authInfo["present"])
        assertEquals(true, authInfo["uidMatchesSub"])
        assertEquals(true, authInfo["rawTokenPresent"])
        assertEquals("password", authInfo["signInProvider"])
        assertEquals(PROJECT_ID, authInfo["aud"])

        // 3. App Check enforcement & limitedUseAppCheckTokens replay protection
        val unverifiedAppCheckErr = expectFunctionsException {
            Tasks.await(
                functions.getHttpsCallable("pyricCallableEnforced").call(mapOf("probe" to 1)),
                15,
                TimeUnit.SECONDS
            )
        }
        assertEquals(FirebaseFunctionsException.Code.UNAUTHENTICATED, unverifiedAppCheckErr.code)

        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)

        val enforcedOk = Tasks.await(
            functions.getHttpsCallable("pyricCallableEnforced").call(mapOf("probe" to 2)),
            15,
            TimeUnit.SECONDS
        )
        @Suppress("UNCHECKED_CAST")
        val appInfo = (enforcedOk.data as Map<String, Any?>)["app"] as Map<String, Any?>
        assertEquals(true, appInfo["present"])
        assertEquals(true, appInfo["appIdPresent"])

        // consumeAppCheckToken with limitedUseAppCheckTokens = true mints fresh unconsumed tokens
        val limitedConsume = functions.getHttpsCallable("pyricCallableConsume") {
            limitedUseAppCheckTokens = true
        }
        @Suppress("UNCHECKED_CAST")
        val firstLimited = (Tasks.await(limitedConsume.call("c1"), 15, TimeUnit.SECONDS).data as Map<String, Any?>)["app"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val secondLimited = (Tasks.await(limitedConsume.call("c2"), 15, TimeUnit.SECONDS).data as Map<String, Any?>)["app"] as Map<String, Any?>
        assertEquals(false, firstLimited["alreadyConsumed"])
        assertEquals(false, secondLimited["alreadyConsumed"])

        // Standard cached token consumed twice reports alreadyConsumed == true on second call
        val cachedConsume = functions.getHttpsCallable("pyricCallableConsume")
        @Suppress("UNCHECKED_CAST")
        val firstCached = (Tasks.await(cachedConsume.call("s1"), 15, TimeUnit.SECONDS).data as Map<String, Any?>)["app"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val secondCached = (Tasks.await(cachedConsume.call("s2"), 15, TimeUnit.SECONDS).data as Map<String, Any?>)["app"] as Map<String, Any?>
        assertEquals(false, firstCached["alreadyConsumed"])
        assertEquals(true, secondCached["alreadyConsumed"])

        // 4. getHttpsCallableFromUrl (cloudfunctions.net + Hosting rewrite custom domain) & off-machine refusal
        val fromCfUrl = functions.getHttpsCallableFromUrl(
            URL("https://us-central1-$PROJECT_ID.cloudfunctions.net/pyricCallableEcho")
        )
        @Suppress("UNCHECKED_CAST")
        val cfUrlData = (Tasks.await(fromCfUrl.call(mapOf("via" to "cfUrl")), 15, TimeUnit.SECONDS).data as Map<String, Any?>)["data"] as Map<String, Any?>
        assertEquals("cfUrl", cfUrlData["via"])

        val customDomainFunctions = FirebaseFunctions.getInstance(app, activeBaseUrl)
        @Suppress("UNCHECKED_CAST")
        val rewriteData = (Tasks.await(
            customDomainFunctions.getHttpsCallable("pyricCallableEcho").call(mapOf("via" to "rewrite")),
            15,
            TimeUnit.SECONDS
        ).data as Map<String, Any?>)["data"] as Map<String, Any?>
        assertEquals("rewrite", rewriteData["via"])

        val refusedEx = expectFunctionsException {
            Tasks.await(
                functions.getHttpsCallableFromUrl(URL("https://us-central1-other-proj.cloudfunctions.net/pyricCallableEcho")).call(),
                10,
                TimeUnit.SECONDS
            )
        }
        assertEquals(FirebaseFunctionsException.Code.UNAVAILABLE, refusedEx.code)

        // 5. Structured HttpsError, plain throw INTERNAL, and client withTimeout DEADLINE_EXCEEDED
        val permissionEx = expectFunctionsException {
            Tasks.await(
                functions.getHttpsCallable("pyricCallableEcho").call(
                    mapOf(
                        "mode" to "throw",
                        "code" to "permission-denied",
                        "message" to "caller lacks admin role",
                        "details" to mapOf("required" to "admin")
                    )
                ),
                15,
                TimeUnit.SECONDS
            )
        }
        assertEquals(FirebaseFunctionsException.Code.PERMISSION_DENIED, permissionEx.code)
        assertEquals("caller lacks admin role", permissionEx.message)
        assertEquals(mapOf("required" to "admin"), permissionEx.details)

        val plainEx = expectFunctionsException {
            Tasks.await(
                functions.getHttpsCallable("pyricCallableEcho").call(mapOf("mode" to "throw-plain")),
                15,
                TimeUnit.SECONDS
            )
        }
        assertEquals(FirebaseFunctionsException.Code.INTERNAL, plainEx.code)
        assertNull(plainEx.details)

        val deadlineEx = expectFunctionsException {
            Tasks.await(
                functions.getHttpsCallable("pyricCallableEcho")
                    .withTimeout(150L, TimeUnit.MILLISECONDS)
                    .call(mapOf("mode" to "delay", "ms" to 1500)),
                10,
                TimeUnit.SECONDS
            )
        }
        assertEquals(FirebaseFunctionsException.Code.DEADLINE_EXCEEDED, deadlineEx.code)

        // 6. Live SSE streaming (Message chunks + terminal Result + mid-stream HttpsError)
        val streamEvents = functions.getHttpsCallable("pyricCallableStream")
            .stream(mapOf("chunks" to listOf("alpha", "beta", "gamma")))
            .toList()
        val messageValues = streamEvents.filterIsInstance<StreamResponse.Message>().map { it.message.data }
        assertEquals(listOf("alpha", "beta", "gamma"), messageValues)
        val terminal = streamEvents.last()
        assertTrue(terminal is StreamResponse.Result)
        @Suppress("UNCHECKED_CAST")
        val terminalData = (terminal as StreamResponse.Result).result.data as Map<String, Any?>
        assertEquals(true, terminalData["acceptsStreaming"])

        val partialBeforeThrow = mutableListOf<Any?>()
        val streamThrow = assertThrows(FirebaseFunctionsException::class.java) {
            runBlocking {
                functions.getHttpsCallable("pyricCallableStream")
                    .stream(mapOf("chunks" to listOf("only-chunk", "never-sent"), "mode" to "throw"))
                    .collect { item ->
                        if (item is StreamResponse.Message) {
                            partialBeforeThrow.add(item.message.data)
                        }
                    }
            }
        }
        assertEquals(listOf<Any?>("only-chunk"), partialBeforeThrow)
        assertEquals(FirebaseFunctionsException.Code.FAILED_PRECONDITION, streamThrow.code)
        assertEquals("stream failed after one chunk", streamThrow.message)
        assertFalse(partialBeforeThrow.isEmpty())
        println("PYRIC_KT_FUNCTIONS_LIVE_VERIFIED=1")
    }

    private fun expectFunctionsException(block: () -> Unit): FirebaseFunctionsException {
        val exec = assertThrows(ExecutionException::class.java, block)
        val cause = exec.cause
        assertTrue(cause is FirebaseFunctionsException, "Expected FirebaseFunctionsException but got $cause")
        return cause as FirebaseFunctionsException
    }

    companion object {
        private const val PROJECT_ID = "demo-functions-callable"
        private const val APP_ID = "1:000000000000:android:0000000000000000"
    }
}
