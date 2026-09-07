package dev.pyric.database.internal

import java.security.SecureRandom

internal object PushIdGenerator {
    private const val PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
    private val random = SecureRandom()
    private var lastPushTime = 0L
    private val lastRandChars = IntArray(12)

    @Synchronized
    fun generatePushId(now: Long = System.currentTimeMillis()): String {
        val duplicateTime = (now == lastPushTime)
        lastPushTime = now

        val timeStampChars = CharArray(8)
        var time = now
        for (i in 7 downTo 0) {
            timeStampChars[i] = PUSH_CHARS[(time % 64).toInt()]
            time /= 64
        }

        val id = StringBuilder(20)
        id.append(timeStampChars)

        if (!duplicateTime) {
            for (i in 0 until 12) {
                lastRandChars[i] = random.nextInt(64)
            }
        } else {
            var i = 11
            while (i >= 0 && lastRandChars[i] == 63) {
                lastRandChars[i] = 0
                i--
            }
            if (i >= 0) {
                lastRandChars[i]++
            }
        }

        for (i in 0 until 12) {
            id.append(PUSH_CHARS[lastRandChars[i]])
        }

        return id.toString()
    }
}
