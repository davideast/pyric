package dev.pyric.example.todo.data

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class FirestoreTodoRepositoryTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var firestore: FirebaseFirestore
    private lateinit var repository: FirestoreTodoRepository
    private val recordedOps = CopyOnWriteArrayList<Map<String, Any?>>()

    @Before
    fun setUp() {
        recordedOps.clear()
        transport = InMemoryBridgeTransport()
        firestore = dev.pyric.example.todo.TestFirestoreFactory.create(transport)
        repository = FirestoreTodoRepository(firestore)

        transport.onServerReceive { json ->
            val map = JsonCodec.decodeMap(json)
            val type = map["type"] as? String

            when (type) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = map["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = map["op"] as Map<String, Any?>
                    recordedOps.add(op)
                    val method = op["method"] as String

                    when (method) {
                        "setDoc", "updateDoc", "deleteDoc" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true}""")
                        }
                        else -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = map["subId"] as String
                    transport.sendToClient(
                        """{"type":"worker-snap","subId":"$subId","value":{"docs":[{"id":"doc-1","path":"todos/doc-1","exists":true,"data":{"title":"Alpha","completed":false,"createdAt":{"__type":"timestamp","seconds":1000,"nanos":0}}},{"id":"doc-2","path":"todos/doc-2","exists":true,"data":{"title":"Beta","completed":true,"createdAt":{"__type":"timestamp","seconds":2000,"nanos":0}}}],"docChanges":[]}}"""
                    )
                }
            }
        }
    }

    @Test
    fun testAddTodoDispatchesCorrectOp() = runBlocking {
        repository.addTodo("Buy groceries", "user-1")

        val op = recordedOps.find { it["method"] == "setDoc" }
        assertNotNull("Expected setDoc operation", op)
        val path = op!!["path"] as String
        assertTrue("Expected path to start with todos/", path.startsWith("todos/"))

        @Suppress("UNCHECKED_CAST")
        val data = op["data"] as Map<String, Any?>

        assertEquals("Buy groceries", data["title"])
        assertEquals(false, data["completed"])
        assertNotNull(data["createdAt"])
    }

    @Test
    fun testAddTodoBlankTitleThrows() = runBlocking {
        try {
            repository.addTodo("   ", "user-1")
            fail("Expected IllegalArgumentException for blank title")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("cannot be blank"))
        }
    }

    @Test
    fun testToggleTodoDispatchesUpdate() = runBlocking {
        repository.toggleTodo("task-123", completed = false)

        val op = recordedOps.find { it["method"] == "updateDoc" }
        assertNotNull("Expected updateDoc operation", op)
        assertEquals("todos/task-123", op!!["path"])

        @Suppress("UNCHECKED_CAST")
        val data = op["data"] as Map<String, Any?>
        assertEquals(true, data["completed"])
    }

    @Test
    fun testDeleteTodoDispatchesDelete() = runBlocking {
        repository.deleteTodo("task-456")

        val op = recordedOps.find { it["method"] == "deleteDoc" }
        assertNotNull("Expected deleteDoc operation", op)
        assertEquals("todos/task-456", op!!["path"])
    }

    @Test
    fun testGetTodosStreamSortsDescendingByTimestamp() = runBlocking {
        val todos = repository.getTodosStream("user-1").first()
        assertEquals(2, todos.size)
        // Beta (2000s) should be first, Alpha (1000s) second
        assertEquals("doc-2", todos[0].id)
        assertEquals("Beta", todos[0].title)
        assertTrue(todos[0].completed)

        assertEquals("doc-1", todos[1].id)
        assertEquals("Alpha", todos[1].title)
        assertFalse(todos[1].completed)
    }

    @Test
    fun testIsBridgeConnectedReflectsBridgeState() = runBlocking {
        // Before connecting, should be false
        assertFalse(repository.isBridgeConnected())
        // After an operation triggers attach, should be true
        repository.deleteTodo("dummy-id")
        assertTrue(repository.isBridgeConnected())
    }
}
