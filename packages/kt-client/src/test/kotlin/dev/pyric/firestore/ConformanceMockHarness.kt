package dev.pyric.firestore

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.util.concurrent.CopyOnWriteArrayList

class ConformanceMockHarness {
    val sentMessages = CopyOnWriteArrayList<Map<String, Any?>>()
    val transport = InMemoryBridgeTransport()
    val bridgeClient = PyricBridgeClient(transport)
    val app: FirebaseApp
    val firestore: FirebaseFirestore

    init {
        app = FirebaseApp.initializeApp(
            "test-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-test")
                .setApiKey("fake-key")
                .setApplicationId("fake-app")
                .build()
        )
        firestore = FirebaseFirestore(bridgeClient, app, "(default)")

        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            sentMessages.add(msg)
            val type = msg["type"] as? String

            when (type) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String

                    when (method) {
                        "getDoc" -> {
                            val path = (op["path"] as? String) ?: "users/alice"
                            val idPart = path.substringAfterLast('/')
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"$idPart","path":"$path","exists":true,"data":{"json":"{\"name\":\"Alice\",\"age\":30}"}}}"""
                            )
                        }
                        "getDocs" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"docs":[{"id":"1","path":"users/1","exists":true,"data":{"json":"{\"name\":\"A\"}"}},{"id":"2","path":"users/2","exists":true,"data":{"json":"{\"name\":\"B\"}"}}]}}"""
                            )
                        }
                        "count" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":{"count":42}}""")
                        }
                        "aggregate" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"data":{"sum_score":150.0,"avg_score":75.0}}}"""
                            )
                        }
                        else -> {
                            // setDoc, updateDoc, deleteDoc, addDoc, batchCommit, txnCommit
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    @Suppress("UNCHECKED_CAST")
                    val target = sub["target"] as Map<String, Any?>
                    val refType = target["__ref"] as? String

                    if (refType == "doc") {
                        val path = (target["path"] as? String) ?: "todos/task1"
                        val idPart = path.substringAfterLast('/')
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"id":"$idPart","path":"$path","exists":true,"data":{"json":"{\"status\":\"online\"}"}}}"""
                        )
                    } else {
                        val path = (target["path"] as? String) ?: "coll"
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"docs":[{"id":"doc1","path":"$path/doc1","exists":true,"data":{"json":"{\"item\":1}"}}]}}"""
                        )
                    }
                }
            }
        }
    }
}
