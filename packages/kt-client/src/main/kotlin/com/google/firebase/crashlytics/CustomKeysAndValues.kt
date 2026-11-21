package com.google.firebase.crashlytics

class CustomKeysAndValues internal constructor(
    internal val keysAndValues: Map<String, Any>
) {
    class Builder {
        private val entries = LinkedHashMap<String, Any>()

        fun putString(key: String, value: String): Builder {
            entries[key] = value
            return this
        }

        fun putBoolean(key: String, value: Boolean): Builder {
            entries[key] = value
            return this
        }

        fun putDouble(key: String, value: Double): Builder {
            entries[key] = normalizeFiniteDouble(value)
            return this
        }

        fun putFloat(key: String, value: Float): Builder {
            entries[key] = if (value.isFinite()) {
                value.toString().toDouble()
            } else {
                value.toString()
            }
            return this
        }

        fun putLong(key: String, value: Long): Builder {
            entries[key] = value
            return this
        }

        fun putInt(key: String, value: Int): Builder {
            entries[key] = value
            return this
        }

        fun build(): CustomKeysAndValues = CustomKeysAndValues(LinkedHashMap(entries))

        companion object {
            internal fun normalizeFiniteDouble(value: Double): Any =
                if (value.isFinite()) value else value.toString()
        }
    }
}
