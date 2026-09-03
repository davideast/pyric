package kotlinx.coroutines.tasks

import com.google.android.gms.tasks.Task
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) {
            cont.resume(task.getResult())
        } else {
            cont.resumeWithException(task.exception ?: RuntimeException("Task failed without exception"))
        }
    }
}
