package dev.pyric.conformance.androidoracle

import android.os.Looper
import com.google.android.gms.tasks.Task
import org.json.JSONArray
import org.robolectric.Shadows
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal fun <T> awaitFirebaseTask(task: Task<T>, timeoutMs: Long = 30_000L): T {
    val mainLooper = Looper.getMainLooper()
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (!task.isComplete) {
        Shadows.shadowOf(mainLooper).idle()
        if (System.nanoTime() >= deadline) {
            throw TimeoutException("Timed out waiting for Firebase Task after ${timeoutMs}ms")
        }
        Thread.sleep(10)
    }
    Shadows.shadowOf(mainLooper).idle()
    if (task.isCanceled) {
        throw CancellationException("Firebase Task was canceled")
    }
    val error = task.exception
    if (error != null) {
        throw error
    }
    @Suppress("UNCHECKED_CAST")
    return task.result as T
}

internal fun flushCleanupUidsSidecar(cleanupUidsPath: String, uids: List<String>) {
    if (cleanupUidsPath.isBlank()) {
        return
    }
    val sidecarFile = File(cleanupUidsPath)
    sidecarFile.parentFile?.mkdirs()
    sidecarFile.writeText(JSONArray(uids).toString() + "\n", Charsets.UTF_8)
}
