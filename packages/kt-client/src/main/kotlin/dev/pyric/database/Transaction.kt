package dev.pyric.database

object Transaction {
    class Result internal constructor(
        val isSuccess: Boolean,
        val mutableData: MutableData?
    )

    @JvmStatic
    fun success(mutableData: MutableData): Result = Result(true, mutableData)

    @JvmStatic
    fun abort(): Result = Result(false, null)

    interface Handler {
        fun doTransaction(currentData: MutableData): Result
        fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?)
    }
}
