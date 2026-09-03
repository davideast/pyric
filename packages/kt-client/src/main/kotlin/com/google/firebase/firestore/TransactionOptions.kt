package com.google.firebase.firestore

class TransactionOptions private constructor(
    val maxAttempts: Int
) {
    class Builder {
        private var maxAttempts: Int = 5

        fun setMaxAttempts(maxAttempts: Int): Builder = apply {
            require(maxAttempts > 0) { "Max attempts must be at least 1" }
            this.maxAttempts = maxAttempts
        }

        fun build(): TransactionOptions = TransactionOptions(maxAttempts)
    }

    companion object {
        fun defaultOptions(): TransactionOptions = Builder().build()
    }
}
