package dev.pyric.example.todo.stress

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.codecs.JsonCodec
import dev.pyric.example.todo.TestFirestoreFactory
import dev.pyric.example.todo.data.Todo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Empirical stress tests for [Todo] domain model and snapshot deserialization
 * under extreme inputs, boundary timestamps, and adversarial character sets.
 */
class TodoEdgeCasesStressTest {

    private lateinit var firestore: FirebaseFirestore
    private lateinit var transport: InMemoryBridgeTransport

    @Before
    fun setUp() {
        transport = InMemoryBridgeTransport()
        firestore = TestFirestoreFactory.create(transport)
    }

    @Test
    fun testEmptyAndWhitespaceTitles() {
        val emptyTodo = Todo(id = "e-1", title = "")
        assertEquals("", emptyTodo.title)
        assertFalse(emptyTodo.completed)

        val whitespaceTodo = Todo(id = "w-1", title = "   \t\r\n   ")
        assertEquals("   \t\r\n   ", whitespaceTodo.title)
    }

    @Test
    fun testVeryLongTitleExceeding10kCharacters() {
        val largeTitle = "A".repeat(15_000)
        val todo = Todo(id = "long-1", title = largeTitle, completed = false)

        assertEquals(15_000, todo.title.length)
        assertEquals(largeTitle, todo.title)

        val toggled = todo.copy(completed = true)
        assertEquals(15_000, toggled.title.length)
        assertTrue(toggled.completed)
    }

    @Test
    fun testSpecialUnicodeCharactersAndEmojis() {
        val testVectors = listOf(
            "📝 買い物リスト: 牛乳, 卵, 빵 🍞",
            "👨‍👩‍👧‍👦 👨‍💻 🏳️‍🌈 🏃🏽‍♀️", // ZWJ sequences & skin tone modifiers
            "עברית שפת שלום / العربية لغة الضاد", // RTL Hebrew and Arabic
            "Quotes: \"double\" 'single' `backtick` \\slash /forward \n \r \t \u0000 \uFFFF",
            "𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝒯ℯ𝓈𝓉 ∑ ∫ 𝜕 ∇ ∰ ℵ₀", // Mathematical symbols & gothic font
            "<script>alert('xss')</script> -- DROP TABLE todos;" // Injection-like payload
        )

        for ((index, vector) in testVectors.withIndex()) {
            val todo = Todo(id = "uni-$index", title = vector)
            assertEquals("Failed for vector index $index", vector, todo.title)
        }
    }

    @Test
    fun testPre1970AndBoundaryTimestamps() {
        // Minimum valid Firestore timestamp: 0001-01-01T00:00:00Z
        val minTimestamp = Timestamp(-62135596800L, 0)
        val minTodo = Todo(id = "min-1", title = "Ancient task", createdAt = minTimestamp)
        assertEquals(-62135596800L, minTodo.createdAt?.seconds)
        assertEquals(0, minTodo.createdAt?.nanoseconds)

        // Pre-1970 epoch (1969-12-31)
        val pre1970Timestamp = Timestamp(-1000L, 500_000)
        val preTodo = Todo(id = "pre-1", title = "Pre-1970 task", createdAt = pre1970Timestamp)
        assertEquals(-1000L, preTodo.createdAt?.seconds)
        assertEquals(500_000, preTodo.createdAt?.nanoseconds)

        // Epoch zero (1970-01-01T00:00:00Z)
        val zeroTimestamp = Timestamp(0L, 0)
        val zeroTodo = Todo(id = "zero-1", title = "Epoch zero task", createdAt = zeroTimestamp)
        assertEquals(0L, zeroTodo.createdAt?.seconds)

        // Year 2038 32-bit signed rollover boundary
        val y2038Timestamp = Timestamp(Int.MAX_VALUE.toLong(), 999_999_999)
        val y2038Todo = Todo(id = "y2038", title = "Y2038 task", createdAt = y2038Timestamp)
        assertEquals(Int.MAX_VALUE.toLong(), y2038Todo.createdAt?.seconds)

        // Maximum valid Firestore timestamp: 9999-12-31T23:59:59.999999999Z
        val maxTimestamp = Timestamp(253402300799L, 999_999_999)
        val maxTodo = Todo(id = "max-1", title = "Far future task", createdAt = maxTimestamp)
        assertEquals(253402300799L, maxTodo.createdAt?.seconds)
        assertEquals(999_999_999, maxTodo.createdAt?.nanoseconds)

        // Out of bounds timestamps should throw in Timestamp validation
        try {
            Timestamp(-62135596801L, 0)
            fail("Expected IllegalArgumentException for seconds < -62135596800L")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message?.contains("out of range") == true)
        }

        try {
            Timestamp(253402300800L, 0)
            fail("Expected IllegalArgumentException for seconds > 253402300799L")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message?.contains("out of range") == true)
        }
    }

    @Test
    fun testFromSnapshotWithExtremeValues() {
        val longTitle = "Unicode-Title-".repeat(1000)
        transport.onServerReceive { json ->
            val map = JsonCodec.decodeMap(json)
            val type = map["type"] as? String
            if (type == "attach") {
                transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            } else if (type == "worker-op") {
                val id = map["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = map["op"] as Map<String, Any?>
                val path = op["path"] as? String ?: ""
                when {
                    path.contains("doc-extreme") -> {
                        transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"doc-extreme","path":"todos/doc-extreme","exists":true,"data":{"title":"$longTitle","completed":true,"createdAt":{"__type":"timestamp","seconds":-1000,"nanos":250000}}}}"""
                        )
                    }
                    path.contains("doc-corrupted") -> {
                        // Snapshot where title is boolean, completed is string, createdAt is unexpected map
                        transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"doc-corrupted","path":"todos/doc-corrupted","exists":true,"data":{"title":12345,"completed":"yes","createdAt":"not-a-timestamp"}}}"""
                        )
                    }
                }
            }
        }

        val extremeSnap = Tasks.await(firestore.document("todos/doc-extreme").get())
        val extremeTodo = Todo.fromSnapshot(extremeSnap)
        assertEquals("doc-extreme", extremeTodo.id)
        assertEquals(longTitle, extremeTodo.title)
        assertTrue(extremeTodo.completed)
        assertEquals(-1000L, extremeTodo.createdAt?.seconds)
        assertEquals(250000, extremeTodo.createdAt?.nanoseconds)

        // Type mismatch snapshot: getString/getBoolean/getTimestamp return null safely
        val corruptedSnap = Tasks.await(firestore.document("todos/doc-corrupted").get())
        val corruptedTodo = Todo.fromSnapshot(corruptedSnap)
        assertEquals("doc-corrupted", corruptedTodo.id)
        assertEquals("", corruptedTodo.title)
        assertFalse(corruptedTodo.completed)
        assertNull(corruptedTodo.createdAt)
    }
}
