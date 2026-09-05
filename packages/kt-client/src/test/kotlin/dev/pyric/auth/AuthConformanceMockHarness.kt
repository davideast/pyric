package dev.pyric.auth

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.util.concurrent.CopyOnWriteArrayList

class AuthConformanceMockHarness {
    val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    val sentSubs = CopyOnWriteArrayList<Map<String, Any?>>()
    val sentUnsubs = CopyOnWriteArrayList<String>()
    val transport = InMemoryBridgeTransport()
    val bridgeClient = PyricBridgeClient(transport)
    val app: FirebaseApp
    val auth: FirebaseAuth
    val firestore: FirebaseFirestore

    init {
        FirebaseApp.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()

        app = FirebaseApp.initializeApp(
            "test-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-test")
                .setApiKey("fake-key")
                .setApplicationId("fake-app")
                .build()
        )
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)

        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            val type = msg["type"] as? String

            when (type) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    val method = op["method"] as String

                    when (method) {
                        "auth.signInEmail" -> {
                            val email = op["email"] as? String
                            val password = op["password"] as? String
                            if (password == "wrong-password") {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/wrong-password","message":"wrong-password"}}"""
                                )
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-alice","email":"$email","displayName":"Alice","isAnonymous":false,"emailVerified":true,"providerId":"password","providerData":[{"uid":"user-alice","email":"$email","providerId":"password"}]},"claims":{"role":"admin","sub":"user-alice"}}}"""
                                )
                            }
                        }
                        "auth.createUser" -> {
                            val email = op["email"] as? String
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-new","email":"$email","isAnonymous":false,"providerId":"password"},"operationType":"signIn","providerId":"password"}}"""
                            )
                        }
                        "auth.signInAnonymously" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"anon-123","isAnonymous":true,"providerId":"firebase"}}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.getIdToken" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":"mock.jwt.token"}""")
                        }
                        "auth.getIdTokenResult" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"mock.jwt.token","claims":{"role":"admin","sub":"user-alice"},"expirationTime":1800000000,"authTime":1700000000,"issuedAtTime":1700000000,"signInProvider":"password"}}"""
                            )
                        }
                        "auth.updateProfile" -> {
                            val displayName = op["displayName"] as? String ?: "Alice"
                            val photoURL = op["photoURL"] as? String
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","displayName":"$displayName","photoURL":"$photoURL","isAnonymous":false}}"""
                            )
                        }
                        "auth.getCurrentUser" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","displayName":"Alice Reloaded","isAnonymous":false}}"""
                            )
                        }
                        "getDoc" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"doc1","path":"users/alice","exists":true,"data":{"json":"{\"status\":\"ok\"}"}}}"""
                            )
                        }
                        else -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    sentSubs.add(sub)
                    val target = sub["target"]
                    if (target is Map<*, *>) {
                        val innerTarget = target["target"] as? String
                        if (innerTarget != "authState" && innerTarget != "idToken") {
                            transport.sendToClient(
                                """{"type":"worker-snap","subId":"$subId","value":{"id":"doc1","path":"users/alice","exists":true,"data":{"json":"{\"status\":\"active\"}"}}}"""
                            )
                        }
                    }
                }
                "worker-unsub" -> {
                    val subId = msg["subId"] as String
                    sentUnsubs.add(subId)
                }
            }
        }
    }
}
