package dev.pyric.conformance.androidoracle

import android.os.Looper
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.firestore.FirebaseFirestore
import org.json.JSONArray
import org.robolectric.Shadows
import org.robolectric.shadows.ShadowLog
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private val FIREBASE_DIAGNOSTIC_TAGS = setOf(
    "FirebaseDatabase",
    "RepoOperation",
    "PersistentConnection",
    "Connection",
    "WebSocket",
    "FirebaseAuth",
    "Firestore",
    "FirestoreCallCredentials",
    "GrpcCallProvider",
    "RemoteStore",
    "WatchStream",
    "SSLCertificateSocketFactory"
)

private val SENSITIVE_VALUE_PATTERN = Regex(
    "(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*|AIza[0-9A-Za-z_-]{20,}|access_token=[^&\\s]+|cred=[^&\\s]+)"
)

internal fun pumpMainLooper() {
    Shadows.shadowOf(Looper.getMainLooper()).idle()
}

internal fun awaitMainLooperCondition(
    label: String,
    timeoutMs: Long = 30_000L,
    predicate: () -> Boolean
) {
    val mainLooper = Looper.getMainLooper()
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (true) {
        Shadows.shadowOf(mainLooper).idle()
        if (predicate()) {
            Shadows.shadowOf(mainLooper).idle()
            return
        }
        if (System.nanoTime() >= deadline) {
            val recentLogs = collectRecentFirebaseLogs()
            throw TimeoutException(
                "Timed out waiting for condition '$label' after ${timeoutMs}ms.$recentLogs"
            )
        }
        Thread.sleep(10)
    }
}

internal fun <T> awaitFirebaseTask(
    task: Task<T>,
    label: String,
    timeoutMs: Long = 30_000L
): T {
    val mainLooper = Looper.getMainLooper()
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (!task.isComplete) {
        Shadows.shadowOf(mainLooper).idle()
        if (System.nanoTime() >= deadline) {
            val recentLogs = collectRecentFirebaseLogs()
            throw TimeoutException(
                "Timed out waiting for Firebase Task '$label' after ${timeoutMs}ms.$recentLogs"
            )
        }
        Thread.sleep(10)
    }
    Shadows.shadowOf(mainLooper).idle()
    if (task.isCanceled) {
        throw CancellationException("Firebase Task '$label' was canceled")
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

internal fun shutdownFirebaseDatabaseAndApp(database: FirebaseDatabase?, app: FirebaseApp) {
    if (database != null) {
        runCatching { database.goOffline() }
        // Allow Repo's ScheduledThreadPoolExecutor to complete deferredInitialization + interrupt
        // before marking FirebaseApp deleted, preventing AndroidAuthTokenProvider from racing
        // against FirebaseApp.checkNotDeleted() on the background RunLoop thread.
        Thread.sleep(150)
        pumpMainLooper()
    }
    runCatching { app.delete() }
    pumpMainLooper()
}

internal fun shutdownFirebaseFirestoreAndApp(firestore: FirebaseFirestore?, app: FirebaseApp) {
    if (firestore != null) {
        runCatching {
            awaitFirebaseTask(firestore.terminate(), "firestore.terminate", 10_000L)
        }
        Thread.sleep(100)
        pumpMainLooper()
    }
    runCatching { app.delete() }
    pumpMainLooper()
}

private fun collectRecentFirebaseLogs(): String {
    val logs = runCatching { ShadowLog.getLogs() }.getOrNull().orEmpty()
    val relevant = logs
        .filter { item -> item.tag in FIREBASE_DIAGNOSTIC_TAGS || item.throwable != null }
        .takeLast(25)
    if (relevant.isEmpty()) {
        return ""
    }
    val formatted = relevant.joinToString(separator = " | ") { item ->
        val base = "[${item.tag}] ${sanitizeLogText(item.msg ?: "")}"
        val err = item.throwable
        if (err != null) {
            "$base (${err.javaClass.name}: ${sanitizeLogText(err.message ?: "")})"
        } else {
            base
        }
    }
    return " Recent Robolectric logs: $formatted"
}

private fun sanitizeLogText(raw: String): String {
    return SENSITIVE_VALUE_PATTERN.replace(raw, "<redacted>")
}
