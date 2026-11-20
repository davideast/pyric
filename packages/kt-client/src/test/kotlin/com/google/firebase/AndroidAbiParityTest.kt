package com.google.firebase

import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.lang.reflect.Modifier
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class AndroidAbiParityTest {

    @AfterEach
    fun tearDown() {
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun firebaseAppContextOverloadsExposeStaticJvmAbiAndManageInstances() {
        val appClass = FirebaseApp::class.java
        val expectedStaticOverloads = listOf(
            "initializeApp" to arrayOf<Class<*>>(Any::class.java),
            "initializeApp" to arrayOf<Class<*>>(Any::class.java, FirebaseOptions::class.java),
            "initializeApp" to arrayOf<Class<*>>(Any::class.java, FirebaseOptions::class.java, String::class.java),
            "getApps" to arrayOf<Class<*>>(Any::class.java),
        )
        for ((methodName, paramTypes) in expectedStaticOverloads) {
            val method = appClass.getMethod(methodName, *paramTypes)
            assertTrue(Modifier.isStatic(method.modifiers), "Expected $methodName to be @JvmStatic")
        }

        val fakeAndroidContext = object {}
        val customDefaultOptions = FirebaseOptions.Builder()
            .setProjectId("demo-project")
            .setApiKey("demo-api-key")
            .setApplicationId("1:1234567890:android:abcdef")
            .build()
        val secondaryOptions = FirebaseOptions.Builder()
            .setProjectId("secondary-project")
            .setApiKey("secondary-api-key")
            .setApplicationId("1:1234567890:android:fedcba")
            .build()

        val configuredDefault = FirebaseApp.initializeApp(fakeAndroidContext, customDefaultOptions)
        assertEquals(FirebaseApp.DEFAULT_APP_NAME, configuredDefault.name)
        assertEquals("demo-project", configuredDefault.options.projectId)

        // Calling initializeApp(context) when [DEFAULT] already exists returns it without clobbering options.
        val resolvedDefault = FirebaseApp.initializeApp(fakeAndroidContext)
        assertSame(configuredDefault, resolvedDefault)
        assertEquals("demo-project", resolvedDefault.options.projectId)
        assertSame(configuredDefault, Firebase.app)

        val secondary = FirebaseApp.initializeApp(fakeAndroidContext, secondaryOptions, "secondary")
        assertEquals("secondary", secondary.name)
        assertEquals("secondary-project", secondary.options.projectId)
        assertSame(secondary, Firebase.app("secondary"))

        val apps = FirebaseApp.getApps(fakeAndroidContext)
        assertEquals(setOf(FirebaseApp.DEFAULT_APP_NAME, "secondary"), apps.map { it.name }.toSet())
    }

    @Test
    fun preCanceledTaskInvokesSyncAndExecutorCanceledListenersWithoutSuccessOrFailure() {
        val task = Tasks.forCanceled<String>()
        assertTrue(task.isComplete)
        assertTrue(task.isCanceled)
        assertFalse(task.isSuccessful)
        assertNull(task.exception)
        assertThrows<java.util.concurrent.CancellationException> { task.getResult() }
        assertThrows<java.util.concurrent.CancellationException> { Tasks.await(task) }

        val syncCanceled = AtomicInteger(0)
        val successCalled = AtomicBoolean(false)
        val failureCalled = AtomicBoolean(false)
        val completedCanceled = AtomicBoolean(false)

        val chained = task
            .addOnSuccessListener { successCalled.set(true) }
            .addOnFailureListener { failureCalled.set(true) }
            .addOnCanceledListener(OnCanceledListener { syncCanceled.incrementAndGet() })
            .addOnCompleteListener { completed -> completedCanceled.set(completed.isCanceled) }

        assertSame(task, chained)
        assertEquals(1, syncCanceled.get())
        assertFalse(successCalled.get())
        assertFalse(failureCalled.get())
        assertTrue(completedCanceled.get())

        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "pyric-cancel-exec-pre").apply { isDaemon = true }
        }
        try {
            val latch = CountDownLatch(1)
            val threadName = AtomicReference<String>()
            task.addOnCanceledListener(Executor { cmd -> executor.execute(cmd) }) {
                threadName.set(Thread.currentThread().name)
                latch.countDown()
            }
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertEquals("pyric-cancel-exec-pre", threadName.get())
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun postCanceledTaskInvokesSyncAndExecutorListenersAndPropagatesThroughContinueWith() {
        val cts = CancellationTokenSource()
        val tcs = TaskCompletionSource<String>(cts.token)
        val task = tcs.task

        val syncCount = AtomicInteger(0)
        val successCalled = AtomicBoolean(false)
        val failureCalled = AtomicBoolean(false)
        val completeCount = AtomicInteger(0)
        val execLatch = CountDownLatch(1)
        val execThread = AtomicReference<String>()

        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "pyric-cancel-exec-post").apply { isDaemon = true }
        }
        try {
            task.addOnSuccessListener { successCalled.set(true) }
            task.addOnFailureListener { failureCalled.set(true) }
            task.addOnCanceledListener { syncCount.incrementAndGet() }
            task.addOnCanceledListener(executor) {
                execThread.set(Thread.currentThread().name)
                execLatch.countDown()
            }
            task.addOnCompleteListener { completeCount.incrementAndGet() }

            val downstream = task.continueWith { "unreachable" }

            assertFalse(task.isComplete)
            assertFalse(cts.token.isCancellationRequested())

            cts.cancel()
            assertTrue(cts.token.isCancellationRequested())
            assertTrue(task.isComplete)
            assertTrue(task.isCanceled)
            assertFalse(task.isSuccessful)
            assertEquals(1, syncCount.get())
            assertEquals(1, completeCount.get())
            assertFalse(successCalled.get())
            assertFalse(failureCalled.get())
            assertTrue(execLatch.await(5, TimeUnit.SECONDS))
            assertEquals("pyric-cancel-exec-post", execThread.get())

            assertTrue(downstream.isComplete)
            assertTrue(downstream.isCanceled)
            assertFalse(tcs.trySetResult("ignored-after-cancel"))
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun suspendCancellableCoroutineAwaitPatternHandlesSuccessFailureAndCancellation() {
        runBlocking {
            suspend fun <T> awaitViaListeners(task: Task<T>): T = suspendCancellableCoroutine { cont ->
                task.addOnSuccessListener { result -> cont.resume(result) }
                task.addOnFailureListener { error -> cont.resumeWithException(error) }
                task.addOnCanceledListener { cont.cancel() }
            }

            assertEquals("ok-value", awaitViaListeners(Tasks.forResult("ok-value")))

            val boom = IllegalArgumentException("synthetic failure")
            val caught = assertThrows<IllegalArgumentException> {
                runBlocking { awaitViaListeners(Tasks.forException<String>(boom)) }
            }
            assertEquals("synthetic failure", caught.message)

            assertThrows<CancellationException> {
                runBlocking { awaitViaListeners(Tasks.forCanceled<String>()) }
            }
            assertThrows<CancellationException> {
                runBlocking { Tasks.forCanceled<String>().await() }
            }

            val cts = CancellationTokenSource()
            val pending = TaskCompletionSource<String>(cts.token)
            Thread {
                Thread.sleep(25)
                cts.cancel()
            }.apply { isDaemon = true }.start()

            assertThrows<CancellationException> {
                runBlocking { awaitViaListeners(pending.task) }
            }
        }
    }
}
