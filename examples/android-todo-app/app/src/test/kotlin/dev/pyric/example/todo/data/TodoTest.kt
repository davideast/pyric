package dev.pyric.example.todo.data

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TodoTest {

    private lateinit var firestore: FirebaseFirestore
    private lateinit var transport: InMemoryBridgeTransport

    @Before
    fun setUp() {
        transport = InMemoryBridgeTransport()
        firestore = dev.pyric.example.todo.TestFirestoreFactory.create(transport)

        transport.onServerReceive { json ->
            val map = JsonCodec.decodeMap(json)
            val type = map["type"] as? String
            if (type == "attach") {
                transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            } else if (type == "worker-op") {
                val id = map["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = map["op"] as Map<String, Any?>
                val path = op["path"] as? String ?: "todos/item-1"
                if (path.contains("item-complete")) {
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"item-complete","path":"todos/item-complete","exists":true,"data":{"title":"Test Complete","completed":true,"createdAt":{"__type":"timestamp","seconds":1700000000,"nanos":0}}}}"""
                    )
                } else if (path.contains("item-empty")) {
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"item-empty","path":"todos/item-empty","exists":true,"data":{"json":"{}"}}}"""
                    )
                } else {
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"item-1","path":"todos/item-1","exists":true,"data":{"json":"{\"title\":\"Test Todo\",\"completed\":false}"}}}"""
                    )
                }
            }
        }
    }

    @Test
    fun testDefaultValues() {
        val todo = Todo()
        assertEquals("", todo.id)
        assertEquals("", todo.title)
        assertFalse(todo.completed)
        assertNull(todo.createdAt)
    }

    @Test
    fun testCustomValues() {
        val timestamp = Timestamp(1700000000L, 0)
        val todo = Todo(
            id = "t-123",
            title = "Write tests",
            completed = true,
            createdAt = timestamp
        )
        assertEquals("t-123", todo.id)
        assertEquals("Write tests", todo.title)
        assertTrue(todo.completed)
        assertEquals(timestamp, todo.createdAt)
    }

    @Test
    fun testFromSnapshotPopulated() {
        val snapshot = Tasks.await(firestore.document("todos/item-complete").get())
        val todo = Todo.fromSnapshot(snapshot)

        assertEquals("item-complete", todo.id)
        assertEquals("Test Complete", todo.title)
        assertTrue(todo.completed)
        assertEquals(1700000000L, todo.createdAt?.seconds)
    }

    @Test
    fun testFromSnapshotEmptyFields() {
        val snapshot = Tasks.await(firestore.document("todos/item-empty").get())
        val todo = Todo.fromSnapshot(snapshot)

        assertEquals("item-empty", todo.id)
        assertEquals("", todo.title)
        assertFalse(todo.completed)
        assertNull(todo.createdAt)
    }

    @Test
    fun testCopyModifier() {
        val original = Todo(id = "1", title = "Task", completed = false)
        val toggled = original.copy(completed = true)
        assertEquals("1", toggled.id)
        assertEquals("Task", toggled.title)
        assertTrue(toggled.completed)
    }
}
