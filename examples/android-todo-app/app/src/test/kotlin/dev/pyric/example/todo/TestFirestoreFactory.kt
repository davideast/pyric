package dev.pyric.example.todo

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient

object TestFirestoreFactory {
    fun create(transport: InMemoryBridgeTransport): FirebaseFirestore {
        val bridge = PyricBridgeClient(transport)
        val app = FirebaseApp.initializeApp(
            "test-app-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("test-project")
                .setApiKey("test-api-key")
                .setApplicationId("test-app-id")
                .build()
        )
        val ctor = FirebaseFirestore::class.java.declaredConstructors.first {
            it.parameterTypes.size == 3
        }
        ctor.isAccessible = true
        return ctor.newInstance(bridge, app, "(default)") as FirebaseFirestore
    }
}
