package com.google.firebase.firestore

import dev.pyric.codecs.DocumentDataEnvelope
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap

internal object QueryCacheStore {
    private val caches = Collections.synchronizedMap(
        WeakHashMap<FirebaseFirestore, ConcurrentHashMap<Pair<String, Map<String, Any?>>, List<Map<String, Any?>>>>()
    )

    fun put(
        firestore: FirebaseFirestore,
        target: Map<String, Any?>,
        rawDocs: List<Map<String, Any?>>,
        authScope: String = firestore.offlineCoordinator.currentAuthScope()
    ) {
        recordDocumentsInOfflineCoordinator(firestore, rawDocs, authScope)
        if (!firestore.firestoreSettings.isPersistenceEnabled) return
        val store = synchronized(caches) {
            caches.getOrPut(firestore) { ConcurrentHashMap() }
        }
        store[authScope to target] = rawDocs.map { it.toMap() }
    }

    fun get(
        firestore: FirebaseFirestore,
        target: Map<String, Any?>,
        authScope: String = firestore.offlineCoordinator.currentAuthScope()
    ): List<Map<String, Any?>>? {
        if (!firestore.firestoreSettings.isPersistenceEnabled) return null
        val store = synchronized(caches) { caches[firestore] } ?: return null
        return store[authScope to target]?.map { it.toMap() }
    }

    fun clear(firestore: FirebaseFirestore) {
        synchronized(caches) {
            caches.remove(firestore)
        }
    }

    fun clearAllForTest() {
        synchronized(caches) {
            caches.clear()
        }
    }

    fun isNetworkEnabled(firestore: FirebaseFirestore): Boolean =
        firestore.offlineCoordinator.isNetworkEnabled

    private fun recordDocumentsInOfflineCoordinator(
        firestore: FirebaseFirestore,
        rawDocs: List<Map<String, Any?>>,
        authScope: String
    ) {
        for (docMap in rawDocs) {
            val docPath = docMap["path"] as? String ?: continue
            val rawData = docMap["data"]
            val unpacked = DocumentDataEnvelope.unpack(rawData) { p -> firestore.unvalidatedDocumentRef(p) }
            val envelope = DocumentDataEnvelope.extractEnvelope(rawData)
            firestore.offlineCoordinator.recordServerDoc(docPath, true, unpacked, envelope, authScope)
        }
    }
}
