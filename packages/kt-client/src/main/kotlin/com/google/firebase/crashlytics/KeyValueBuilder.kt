package com.google.firebase.crashlytics

class KeyValueBuilder() {
    private val builder = CustomKeysAndValues.Builder()
    private var legacyTarget: FirebaseCrashlytics? = null

    @Deprecated("Don't construct KeyValueBuilder directly; use FirebaseCrashlytics.setCustomKeys { ... } instead.")
    constructor(crashlytics: FirebaseCrashlytics) : this() {
        this.legacyTarget = crashlytics
    }

    fun key(key: String, value: Boolean) {
        builder.putBoolean(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    fun key(key: String, value: Double) {
        builder.putDouble(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    fun key(key: String, value: Float) {
        builder.putFloat(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    fun key(key: String, value: Int) {
        builder.putInt(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    fun key(key: String, value: Long) {
        builder.putLong(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    fun key(key: String, value: String) {
        builder.putString(key, value)
        legacyTarget?.setCustomKey(key, value)
    }

    internal fun build(): CustomKeysAndValues = builder.build()
}
