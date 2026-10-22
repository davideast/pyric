package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ServerTimestamp
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Custom objects in `set` and `toObject`, as the Firebase Android SDK maps them:
 * properties become fields, `@DocumentId` is filled from the snapshot and left
 * out of writes, and a null `@ServerTimestamp` is written as the server time.
 */
class CustomObjectMappingTest {
    enum class Priority { LOW, HIGH }
    data class Owner(val uid: String = "", val name: String = "")
    data class Item(
        @DocumentId val id: String = "",
        val title: String = "",
        val done: Boolean = false,
        val count: Long = 0,
        val priority: Priority = Priority.LOW,
        val tags: List<String> = emptyList(),
        val owner: Owner = Owner(),
        @ServerTimestamp val createdAt: Timestamp? = null,
    )
    data class Linked(@DocumentId val ref: DocumentReference? = null, val title: String = "")

    private val transport = InMemoryBridgeTransport()
    private val ops = CopyOnWriteArrayList<Map<String, Any?>>()
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        FirebaseFirestore.clearInstancesForTest()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    ops.add(op)
                    val value = when (op["method"]) {
                        "getDoc" -> {
                            val data = """{\"title\":\"milk\",\"done\":true,\"count\":3,\"priority\":\"HIGH\",\"tags\":[\"a\"],\"owner\":{\"uid\":\"u1\",\"name\":\"Ann\"}}"""
                            """{"id":"item-7","path":"${op["path"]}","exists":true,"data":{"json":"$data"}}"""
                        }
                        "runTransaction", "transaction.begin" -> """{"txId":"t1"}"""
                        else -> "null"
                    }
                    transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":$value}""")
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "custom-objects-${System.nanoTime()}",
            FirebaseOptions.Builder().setProjectId("demo").setApiKey("k").setApplicationId("a").build(),
        )
        firestore = FirebaseFirestore(PyricBridgeClient(transport), app, "(default)")
    }

    @AfterEach
    fun tearDown() = FirebaseFirestore.clearInstancesForTest()

    /** The `data` field of the first op with [method], decoded from its wire envelope. */
    @Suppress("UNCHECKED_CAST")
    private fun writtenData(method: String): Map<String, Any?> {
        val deadline = System.currentTimeMillis() + 2_000
        while (ops.none { it["method"] == method } && System.currentTimeMillis() < deadline) Thread.sleep(10)
        val data = ops.first { it["method"] == method }["data"] as Map<String, Any?>
        val json = data["json"] as? String
        return if (json != null) JsonCodec.decodeMap(json) else data
    }

    @Test
    fun setWritesPropertiesLeavesOutDocumentIdAndStampsANullServerTimestamp() {
        firestore.document("items/item-7").set(
            Item(id = "ignored", title = "milk", done = true, count = 3, priority = Priority.HIGH, tags = listOf("a"), owner = Owner("u1", "Ann"))
        )
        val data = writtenData("setDoc")
        assertFalse("id" in data, "@DocumentId must not be written: $data")
        assertEquals("milk", data["title"])
        assertEquals(true, data["done"])
        assertEquals(3L, (data["count"] as Number).toLong())
        assertEquals("HIGH", data["priority"])
        assertEquals(listOf("a"), data["tags"])
        assertEquals(mapOf("uid" to "u1", "name" to "Ann"), data["owner"])
        assertEquals(mapOf("__sentinel" to "serverTimestamp"), data["createdAt"])
    }

    @Test
    fun aBatchSetAcceptsACustomObject() {
        // Threw IllegalArgumentException("Custom object serialization not yet supported in set()").
        firestore.batch().set(firestore.document("items/a"), Item(title = "batched"))
    }

    @Test
    fun toObjectFillsTheDocumentIdFromTheSnapshot() {
        val snapshot = Tasks.await(firestore.document("items/item-7").get())
        val item = snapshot.toObject(Item::class.java)!!
        assertEquals("item-7", item.id)
        assertEquals("milk", item.title)
        assertEquals(Priority.HIGH, item.priority)
        assertEquals(Owner("u1", "Ann"), item.owner)

        val linked = snapshot.toObject(Linked::class.java)!!
        assertEquals("items/item-7", linked.ref?.path)
    }
}
