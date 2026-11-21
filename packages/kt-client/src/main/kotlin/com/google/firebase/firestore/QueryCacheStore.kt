package com.google.firebase.firestore

import dev.pyric.codecs.DocumentDataEnvelope
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap

internal object QueryCacheStore {
    private val caches = Collections.synchronizedMap(
        WeakHashMap<FirebaseFirestore, ConcurrentHashMap<Map<String, Any?>, List<Map<String, Any?>>>>()
    )

    fun put(
        firestore: FirebaseFirestore,
        target: Map<String, Any?>,
        rawDocs: List<Map<String, Any?>>
    ) {
        recordDocumentsInOfflineCoordinator(firestore, rawDocs)
        if (!firestore.firestoreSettings.isPersistenceEnabled) return
        val store = synchronized(caches) {
            caches.getOrPut(firestore) { ConcurrentHashMap() }
        }
        store[target] = rawDocs.map { it.toMap() }
    }

    fun get(
        firestore: FirebaseFirestore,
        target: Map<String, Any?>
    ): List<Map<String, Any?>>? {
        if (!firestore.firestoreSettings.isPersistenceEnabled) return null
        val store = synchronized(caches) { caches[firestore] } ?: return null
        return store[target]?.map { it.toMap() }
    }

    fun isNetworkEnabled(firestore: FirebaseFirestore): Boolean {
        val coordinator = resolveOfflineCoordinator(firestore) ?: return true
        return runCatching {
            val method = coordinator.javaClass.methods.firstOrNull {
                (it.name == "isNetworkEnabled" || it.name.startsWith("isNetworkEnabled$")) &&
                    it.parameterCount == 0
            }
            (method?.invoke(coordinator) as? Boolean) ?: true
        }.getOrDefault(true)
    }

    private fun recordDocumentsInOfflineCoordinator(
        firestore: FirebaseFirestore,
        rawDocs: List<Map<String, Any?>>
    ) {
        val coordinator = resolveOfflineCoordinator(firestore) ?: return
        runCatching {
            val method = coordinator.javaClass.methods.firstOrNull {
                (it.name == "recordServerDoc" || it.name.startsWith("recordServerDoc$")) &&
                    it.parameterCount == 4
            } ?: return
            for (docMap in rawDocs) {
                val docPath = docMap["path"] as? String ?: continue
                val rawData = docMap["data"]
                val unpacked = DocumentDataEnvelope.unpack(rawData) { p -> firestore.document(p) }
                val envelope = DocumentDataEnvelope.extractEnvelope(rawData)
                method.invoke(coordinator, docPath, true, unpacked, envelope)
            }
        }
    }

    private fun resolveOfflineCoordinator(firestore: FirebaseFirestore): Any? {
        return runCatching {
            val field = firestore.javaClass.declaredFields.firstOrNull {
                it.name == "offlineCoordinator"
            } ?: return null
            field.isAccessible = true
            field.get(firestore)
        }.getOrNull()
    }
}
