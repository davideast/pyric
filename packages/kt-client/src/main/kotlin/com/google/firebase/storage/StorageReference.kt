package com.google.firebase.storage

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import java.net.URI

/**
 * Reference to a Google Cloud Storage object or prefix inside a [FirebaseStorage] bucket,
 * matching upstream Android `com.google.firebase.storage.StorageReference`.
 */
class StorageReference internal constructor(
    val storage: FirebaseStorage,
    internal val wirePath: String
) : Comparable<StorageReference> {

    val bucket: String
        get() = storage.bucket

    /**
     * Full object path relative to the bucket, prefixed with `/` (and `"/"` at the bucket root),
     * matching upstream Android `StorageReference.getPath()`.
     */
    val path: String
        get() = if (wirePath.isEmpty()) "/" else "/$wirePath"

    val name: String
        get() {
            if (wirePath.isEmpty()) return ""
            val lastSlash = wirePath.lastIndexOf('/')
            return if (lastSlash != -1) wirePath.substring(lastSlash + 1) else wirePath
        }

    val parent: StorageReference?
        get() {
            if (wirePath.isEmpty()) return null
            val lastSlash = wirePath.lastIndexOf('/')
            val parentWirePath = if (lastSlash == -1) "" else wirePath.substring(0, lastSlash)
            return StorageReference(storage, parentWirePath)
        }

    val root: StorageReference
        get() = StorageReference(storage, "")

    fun child(pathString: String): StorageReference {
        require(pathString.isNotEmpty()) { "childName cannot be null or empty" }
        val joined = StorageUrlParser.joinWirePaths(wirePath, pathString)
        return StorageReference(storage, joined)
    }

    fun getReferenceFromUrl(fullUrl: String): StorageReference =
        storage.getReferenceFromUrl(fullUrl)

    fun putBytes(bytes: ByteArray): UploadTask =
        UploadTask(this, bytes, null).start()

    fun putBytes(bytes: ByteArray, metadata: StorageMetadata): UploadTask =
        UploadTask(this, bytes, metadata).start()

    fun getBytes(maxDownloadSizeBytes: Long): Task<ByteArray> {
        require(maxDownloadSizeBytes > 0L) { "maxDownloadSizeBytes must be greater than zero" }
        if (wirePath.isEmpty()) {
            throw IllegalArgumentException("getBytes() is not supported at the root of the bucket.")
        }
        return launchStorageTask {
            BridgeStorageOperations.getBytes(this, maxDownloadSizeBytes)
        }
    }

    fun getMetadata(): Task<StorageMetadata> {
        if (wirePath.isEmpty()) {
            throw IllegalArgumentException("getMetadata() is not supported at the root of the bucket.")
        }
        return launchStorageTask {
            BridgeStorageOperations.getMetadata(this)
        }
    }

    fun updateMetadata(metadata: StorageMetadata): Task<StorageMetadata> {
        if (wirePath.isEmpty()) {
            throw IllegalArgumentException("updateMetadata() is not supported at the root of the bucket.")
        }
        return launchStorageTask {
            BridgeStorageOperations.updateMetadata(this, metadata)
        }
    }

    fun getDownloadUrl(): Task<URI> {
        if (wirePath.isEmpty()) {
            throw IllegalArgumentException("getDownloadUrl() is not supported at the root of the bucket.")
        }
        return launchStorageTask {
            BridgeStorageOperations.getDownloadUrl(this)
        }
    }

    fun delete(): Task<Void?> {
        if (wirePath.isEmpty()) {
            throw IllegalArgumentException("delete() is not supported at the root of the bucket.")
        }
        return launchStorageTask {
            BridgeStorageOperations.delete(this)
            null
        }
    }

    fun listAll(): Task<ListResult> =
        launchStorageTask {
            BridgeStorageOperations.listAll(this)
        }

    fun list(maxResults: Int): Task<ListResult> {
        require(maxResults > 0) { "maxResults must be greater than zero" }
        require(maxResults <= 1000) { "maxResults must be at most 1000" }
        return launchStorageTask {
            BridgeStorageOperations.list(this, maxResults, null)
        }
    }

    fun list(maxResults: Int, pageToken: String): Task<ListResult> {
        require(maxResults > 0) { "maxResults must be greater than zero" }
        require(maxResults <= 1000) { "maxResults must be at most 1000" }
        require(pageToken.isNotEmpty()) { "pageToken must be non-empty to resume a previous list() operation" }
        return launchStorageTask {
            BridgeStorageOperations.list(this, maxResults, pageToken)
        }
    }

    private fun <T> launchStorageTask(block: suspend () -> T): Task<T> {
        val tcs = TaskCompletionSource<T>()
        storage.storageScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                tcs.setResult(block())
            } catch (t: Throwable) {
                tcs.setException(StorageException.fromWireException(t))
            }
        }
        return tcs.task
    }

    override fun toString(): String =
        if (wirePath.isEmpty()) "gs://$bucket/" else "gs://$bucket/$wirePath"

    override fun equals(other: Any?): Boolean {
        if (other !is StorageReference) return false
        return other.toString() == toString()
    }

    override fun hashCode(): Int = toString().hashCode()

    override fun compareTo(other: StorageReference): Int =
        toString().compareTo(other.toString())
}
