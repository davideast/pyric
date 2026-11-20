package dev.pyric.database

object Transaction {
    class Result internal constructor(
        isSuccess: Boolean,
        mutableData: MutableData?
    ) : com.google.firebase.database.Transaction.Result(isSuccess, mutableData)

    @JvmStatic
    fun success(mutableData: MutableData): Result = Result(true, mutableData)

    @JvmStatic
    fun abort(): Result = Result(false, null)

    interface Handler : com.google.firebase.database.Transaction.Handler
}
