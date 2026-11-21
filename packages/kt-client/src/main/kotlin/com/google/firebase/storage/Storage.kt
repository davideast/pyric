package com.google.firebase.storage

import com.google.android.gms.tasks.OnCompleteListener
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import java.io.InputStream
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

/** Returns the [FirebaseStorage] instance of the default [FirebaseApp]. */
val Firebase.storage: FirebaseStorage
    get() = FirebaseStorage.getInstance()

/** Returns the [FirebaseStorage] instance for a custom storage bucket at [url]. */
fun Firebase.storage(url: String): FirebaseStorage =
    FirebaseStorage.getInstance(url)

/** Returns the [FirebaseStorage] instance of a given [FirebaseApp]. */
fun Firebase.storage(app: FirebaseApp): FirebaseStorage =
    FirebaseStorage.getInstance(app)

/** Returns the [FirebaseStorage] instance of a given [FirebaseApp] and storage bucket [url]. */
fun Firebase.storage(app: FirebaseApp, url: String): FirebaseStorage =
    FirebaseStorage.getInstance(app, url)

/** Builds a [StorageMetadata] instance using a Kotlin DSL initializer block. */
fun storageMetadata(init: StorageMetadata.Builder.() -> Unit): StorageMetadata {
    val builder = StorageMetadata.Builder()
    builder.init()
    return builder.build()
}

/**
 * Starts listening to this [StorageTask] and emits [TaskState.InProgress] and
 * [TaskState.Paused] snapshots until completion, matching upstream Firebase Android KTX.
 */
val <T : StorageTask<T>.SnapshotBase> StorageTask<T>.taskState: Flow<TaskState<T>>
    get() = callbackFlow {
        val emittedProgress = AtomicBoolean(false)
        val progressListener = OnProgressListener<T> { snapshot ->
            emittedProgress.set(true)
            trySend(TaskState.InProgress(snapshot))
        }
        val pausedListener = OnPausedListener<T> { snapshot ->
            trySend(TaskState.Paused(snapshot))
        }
        val completeListener = OnCompleteListener<T> { completedTask ->
            if (completedTask.isSuccessful) {
                if (!emittedProgress.get()) {
                    trySend(TaskState.InProgress(this@taskState.snapshot))
                }
                close()
            } else {
                val failure = completedTask.exception
                    ?: StorageException(
                        if (completedTask.isCanceled) {
                            StorageException.ERROR_CANCELED
                        } else {
                            StorageException.ERROR_UNKNOWN
                        }
                    )
                close(failure)
            }
        }

        addOnProgressListener(progressListener)
        addOnPausedListener(pausedListener)
        addOnCompleteListener(completeListener)

        awaitClose {
            removeOnProgressListener(progressListener)
            removeOnPausedListener(pausedListener)
            removeOnCompleteListener(completeListener)
        }
    }.buffer(Channel.UNLIMITED)

operator fun UploadTask.TaskSnapshot.component1(): Long = bytesTransferred

operator fun UploadTask.TaskSnapshot.component2(): Long = totalByteCount

operator fun UploadTask.TaskSnapshot.component3(): StorageMetadata? = metadata

operator fun UploadTask.TaskSnapshot.component4(): URI? = uploadSessionUri

operator fun FileDownloadTask.TaskSnapshot.component1(): Long = bytesTransferred

operator fun FileDownloadTask.TaskSnapshot.component2(): Long = totalByteCount

operator fun StreamDownloadTask.TaskSnapshot.component1(): Long = bytesTransferred

operator fun StreamDownloadTask.TaskSnapshot.component2(): Long = totalByteCount

operator fun StreamDownloadTask.TaskSnapshot.component3(): InputStream = stream

operator fun ListResult.component1(): List<StorageReference> = items

operator fun ListResult.component2(): List<StorageReference> = prefixes

operator fun ListResult.component3(): String? = pageToken
