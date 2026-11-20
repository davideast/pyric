package com.google.firebase.database

class Transaction private constructor() {
    open class Result internal constructor(
        val isSuccess: Boolean,
        val mutableData: MutableData?
    )

    interface Handler {
        fun doTransaction(currentData: MutableData): Result
        fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?)
    }

    companion object {
        @JvmStatic
        fun success(mutableData: MutableData): Result = Result(true, mutableData)

        @JvmStatic
        fun abort(): Result = Result(false, null)
    }
}
