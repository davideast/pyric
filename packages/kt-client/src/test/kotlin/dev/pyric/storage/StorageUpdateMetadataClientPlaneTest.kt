package dev.pyric.storage

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class StorageUpdateMetadataClientPlaneTest {
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var storage: FirebaseStorage
    private val observedMethods = CopyOnWriteArrayList<String>()
    private var denyUpdate = false

    @BeforeEach
    fun setUp() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        observedMethods.clear()
        denyUpdate = false
        transport = InMemoryBridgeTransport()
        transport.onServerReceive { frame ->
            val map = JsonCodec.decodeMap(frame)
            when (map["type"]) {
                "attach" -> {
                    val sessionId = (map["clientSessionId"] as? String) ?: "sess-storage-upd-1"
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "attach-ack",
                                "protocol" to 1,
                                "clientSessionId" to sessionId,
                                "peerConnected" to true,
                                "hostInstanceId" to "inst-1"
                            )
                        )
                    )
                }
                "worker-op" -> {
                    val id = map["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = map["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    observedMethods.add(method)
                    if (method == "storage.updateMetadata") {
                        if (denyUpdate) {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to false,
                                        "error" to mapOf(
                                            "code" to "storage/unauthorized",
                                            "message" to "update \"docs/file.txt\" denied by storage.rules"
                                        )
                                    )
                                )
                            )
                        } else {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf(
                                            "bucket" to "demo.appspot.com",
                                            "fullPath" to "docs/file.txt",
                                            "name" to "file.txt",
                                            "size" to 12,
                                            "generation" to "1",
                                            "metageneration" to "2",
                                            "contentType" to "text/markdown"
                                        )
                                    )
                                )
                            )
                        }
                    }
                }
            }
        }
        bridgeClient = PyricBridgeClient(transport)
        runBlocking { bridgeClient.connect() }
        val options = FirebaseOptions.Builder()
            .setProjectId("demo")
            .setApplicationId("1:1:android:1")
            .setApiKey("key")
            .setStorageBucket("demo.appspot.com")
            .build()
        app = FirebaseApp.initializeApp("storage-update-meta-app", options)
        storage = FirebaseStorage.getInstance(app, bridgeClient)
    }

    @AfterEach
    fun tearDown() {
        runBlocking { bridgeClient.disconnect() }
        FirebaseStorage.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun updateMetadataCallsClientPlaneOpAndDoesNotFallbackToPutBytesOnRulesDenial() {
        val ref = storage.reference.child("docs/file.txt")
        val updated = Tasks.await(
            ref.updateMetadata(StorageMetadata.Builder().setContentType("text/markdown").build())
        )
        assertEquals("text/markdown", updated.contentType)
        assertEquals("2", updated.metadataGeneration)
        assertEquals(listOf("storage.updateMetadata"), observedMethods.toList())

        observedMethods.clear()
        denyUpdate = true
        val thrown = assertThrows(ExecutionException::class.java) {
            Tasks.await(ref.updateMetadata(StorageMetadata.Builder().setContentType("text/csv").build()))
        }
        assertTrue(thrown.cause is StorageException)
        assertEquals(StorageException.ERROR_NOT_AUTHORIZED, (thrown.cause as StorageException).errorCode)
        assertEquals(listOf("storage.updateMetadata"), observedMethods.toList())
    }
}
