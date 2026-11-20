package com.google.firebase

open class FirebaseException : Exception {
    protected constructor() : super()
    constructor(detailMessage: String) : super(detailMessage)
    constructor(detailMessage: String, cause: Throwable?) : super(detailMessage, cause)
}
